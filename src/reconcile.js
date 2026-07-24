// Conciliação entre a fatura importada e os lançamentos do app, incluindo a confirmação
// automática de parcelas previstas (a melhoria pedida): uma parcela prevista que já bate
// por IDENTIDADE (descrição + data da compra original + total de parcelas) com uma linha
// de parcelamento da fatura é confirmada sozinha, sem precisar tocar em "+ lançar" — mesmo
// que o valor tenha sofrido um pequeno ajuste de centavos entre faturas.

function normalizeDescricao(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

export function computeParcelaKey(descricao, dataCompraOriginal, parcelaTotal) {
  return `${normalizeDescricao(descricao)}|${dataCompraOriginal}|${parcelaTotal}`;
}

function addMonths(iso, n) {
  // Preserva o "dia" só até onde o mês de destino permitir (ex.: dia 30 virando fevereiro
  // fica 28/29, não "estoura" pra março) — sem isso, um vencimento dia 30 fazia duas
  // previsões seguidas caírem no mesmo mês (a de fevereiro escorregava pra março),
  // empurrando a última parcela um mês adiante do que realmente aconteceria.
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const daysInTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, daysInTarget));
  return target;
}
function ymOf(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

/**
 * Agrupa todas as linhas de parcelamento já importadas (de todas as faturas guardadas)
 * pela identidade estável da compra, ficando só com o estado mais recente de cada grupo
 * (maior parcela_atual visto) — mesma lógica do antigo computeParcelaGroups do HTML,
 * agora rodando sobre o histórico persistido em vez de um SEED_FATURA_ROWS hardcoded.
 */
export function computeParcelaGroups(allFaturaRows) {
  const map = new Map();
  for (const r of allFaturaRows) {
    if (r.tipo !== 'parcelamento' || !r.parcela_total) continue;
    const key = computeParcelaKey(r.descricao, r.data, r.parcela_total);
    const cur = map.get(key);
    if (!cur || r.parcela_atual > cur.parcela_atual) map.set(key, { ...r, key });
  }
  const groups = [];
  for (const r of map.values()) {
    const remaining = r.parcela_total - r.parcela_atual;
    if (remaining <= 0) continue;
    const months = [];
    for (let k = 1; k <= remaining; k++) {
      const dt = addMonths(r.vencimento, k);
      months.push({ ym: ymOf(dt), label: dt.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }), valor: r.valor, numero: r.parcela_atual + k });
    }
    groups.push({ key: r.key, descricao: r.descricao, dataCompraOriginal: r.data, valor: r.valor, parcela_atual: r.parcela_atual, parcela_total: r.parcela_total, remaining, totalRestante: remaining * r.valor, months });
  }
  groups.sort((a, b) => b.totalRestante - a.totalRestante);
  return groups;
}

/**
 * Recria do zero todas as previsões de parcelas futuras ("previsto": true) a partir do
 * histórico de faturas mais atual — em vez de só ir adicionando previsões novas por cima
 * das antigas. É de propósito: previsão nunca é dado real do usuário, só uma projeção; se
 * a fatura mudou o ritmo de cobrança (ex.: pulou um mês, antecipou outro) ou uma parcela já
 * terminou, a previsão antiga fica errada e precisa sumir, não só ganhar uma nova ao lado.
 * Lançamentos já CONFIRMADOS (previsto: false, seja manual ou por auto-conciliação) nunca
 * são tocados aqui — só afeta o que ainda é especulativo.
 */
export function syncPredictions(allFaturaRows, existingExpenses, categories) {
  const groups = computeParcelaGroups(allFaturaRows);
  const catId = (categories.find((c) => c.id === 'a_classificar') || {}).id || 'outros';
  // Se já existe um lançamento real (não previsto) da mesma compra — ex.: o usuário confirmou
  // a parcela 1 via "+lançar" e escolheu uma categoria de verdade —, as previsões das parcelas
  // seguintes herdam essa categoria em vez de cair em "A Classificar", que é só pra quando a
  // fatura documenta a compra antes de qualquer lançamento do usuário existir.
  const categoriaPorKey = new Map();
  existingExpenses.forEach((e) => { if (!e.previsto && e.parcelaKey && e.categoria) categoriaPorKey.set(e.parcelaKey, e.categoria); });

  // Previsões nascidas de um lançamento parcelado manual (origemManual: true — feito pelo
  // usuário antes de qualquer fatura documentar essa compra) não vêm de computeParcelaGroups
  // (que só enxerga linhas de fatura já importada), então nunca seriam regeneradas aqui. Por
  // isso ficam de fora da limpeza: sobrevivem intactas até serem substituídas de verdade pela
  // confirmação automática quando a fatura real chegar (autoConfirmParcelas cuida disso à parte).
  const toRemoveIds = existingExpenses.filter((e) => e.previsto && !e.origemManual).map((e) => e.id);

  const toAdd = [];
  groups.forEach((g) => {
    g.months.forEach((m) => {
      const safeKey = (g.descricao + '|' + m.valor.toFixed(2) + '|' + m.ym).replace(/[^a-zA-Z0-9]/g, '_');
      toAdd.push({
        id: 'seed_' + safeKey,
        descricao: `${g.descricao} (parcela prevista)`,
        valor: m.valor,
        data: m.ym + '-01',
        categoria: categoriaPorKey.get(g.key) || catId,
        previsto: true,
        parcelaKey: g.key,
        parcela_atual: m.numero,
        parcela_total: g.parcela_total,
      });
    });
  });

  return { toAdd, toRemoveIds };
}

function dateDiffDays(iso1, iso2) {
  return Math.abs((new Date(iso1) - new Date(iso2)) / 86400000);
}

// Entre os candidatos não usados com a mesma identidade de parcela, acha o de data mais
// próxima da referência (o vencimento da fatura sendo conciliada) — uma compra recorrente
// pode ter várias parcelas já confirmadas (uma por mês) soltas no pool mais largo, e sem isso
// a busca pegaria a primeira que aparecesse, não necessariamente a certa para esta fatura.
function closestIndexByKey(pool, key, referenceDate) {
  let bestIdx = -1;
  let bestDiff = Infinity;
  pool.forEach((e, i) => {
    if (e.used || e.parcelaKey !== key) return;
    const diff = dateDiffDays(e.data, referenceDate);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  });
  return bestIdx;
}

/**
 * Aplica a confirmação automática: para cada linha de parcelamento da fatura recém
 * importada, procura entre os lançamentos previstos com a MESMA identidade (descrição +
 * data da compra original + total de parcelas) qual tem a data prevista mais próxima do
 * vencimento real — não exige que caia no mesmo mês "nominal", porque o Santander às vezes
 * emite duas faturas dentro do mesmo mês (ex.: uma no dia 1 e outra no dia 30). Quando a
 * fatura mais recente conhecida de um grupo vence no dia 1 (em vez de por volta do dia 30),
 * a previsão de meses futuros pode "pular" o próximo vencimento real (só 29 dias depois, não
 * um mês de calendário completo) e não deixar nenhuma previsão pendente pra essa parcela — se
 * isso acontecer, a linha "N/M" com N > 1 já é prova suficiente (vinda da própria fatura) de
 * que a primeira parcela já foi cobrada antes, então concilia sozinha mesmo sem previsão
 * batendo, sem exigir toque manual (só a parcela 1 de verdade precisa disso, por ser
 * informação genuinamente nova). Ao confirmar, a data do lançamento passa a ser a data de
 * CORTE da fatura (não o vencimento): a janela de conciliação de cada fatura termina no
 * corte, alguns dias antes do vencimento — se a parcela ficasse datada no vencimento, cairia
 * fora da janela da própria fatura a que pertence. Sem corte conhecido, cai no vencimento.
 *
 * IMPORTANTE: o lançamento confirmado ganha um id NOVO, num namespace ('confirmed_...')
 * totalmente separado do namespace das previsões ('seed_...'), em vez de reaproveitar o id
 * da previsão original. O id de uma previsão carrega o mês que ela mirava na hora em que foi
 * criada — como esse mês pode mudar quando a previsão é recalculada depois (ex.: uma fatura
 * no dia 1 faz a previsão "pular" o próximo vencimento real), o RECÁLCULO seguinte podia gerar
 * uma previsão nova com o MESMO id do lançamento já confirmado, e a limpeza de previsões
 * antigas acabava apagando a confirmação junto. Com namespaces sempre diferentes, isso nunca
 * mais colide — a previsão antiga (id velho) é explicitamente removida à parte.
 */
export function autoConfirmParcelas(faturaRows, expenses, dataCorte, categories) {
  const byId = new Map(expenses.map((e) => [e.id, e]));
  const confirmed = [];
  const removedIds = [];
  const usedIds = new Set();
  // "A Classificar": categoria usada só quando a fatura confirma uma parcela que o usuário
  // nunca lançou manualmente antes (sem candidato previsto) — sem isso, cairia sempre em
  // "Parcelamentos", que não ajuda a fazer gestão por tipo de gasto. Quando existe candidato
  // (lançamento manual prévio), a categoria escolhida pelo usuário é sempre preservada.
  const catId = (categories && (categories.find((c) => c.id === 'a_classificar') || {}).id) || 'outros';

  for (const row of faturaRows) {
    if (row.tipo !== 'parcelamento') continue;
    const key = computeParcelaKey(row.descricao, row.data, row.parcela_total);
    const candidates = expenses.filter((e) => e.previsto && e.parcelaKey === key && !usedIds.has(e.id));
    let candidate = null;
    if (candidates.length) {
      candidates.sort((a, b) => dateDiffDays(a.data, row.vencimento) - dateDiffDays(b.data, row.vencimento));
      candidate = candidates[0];
    }
    if (!candidate && !(row.parcela_atual > 1)) continue; // parcela 1 de verdade: precisa confirmação manual

    const descricaoBase = (candidate ? candidate.descricao : row.descricao).replace(/\s*\(parcela prevista\)\s*$/i, '');
    const newId = `confirmed_${key.replace(/[^a-zA-Z0-9]/g, '_')}_${row.vencimento}`;
    if (candidate) {
      usedIds.add(candidate.id);
      if (candidate.id !== newId) { byId.delete(candidate.id); removedIds.push(candidate.id); }
    }
    const updated = {
      id: newId,
      descricao: descricaoBase,
      valor: row.valor,
      data: dataCorte || row.vencimento,
      categoria: candidate ? candidate.categoria : (catId || 'outros'),
      previsto: false,
      conciliadoAutomaticamente: true,
      parcela_atual: row.parcela_atual,
      parcela_total: row.parcela_total,
      parcelaKey: key,
    };
    byId.set(updated.id, updated);
    confirmed.push({ before: candidate, after: updated, faturaRow: row });
  }

  return { updatedExpenses: [...byId.values()], confirmed, removedIds };
}

/**
 * Calcula a janela real de conciliação de uma fatura: termina na data de corte da PRÓPRIA
 * fatura (extraída do PDF — "...compras realizadas até DD/MM") e começa no dia seguinte ao
 * corte da fatura ANTERIOR, cobrindo exatamente o período de compras entre as duas, sem
 * sobra nem lacuna. Sem essa informação (fatura importada via planilha, ou fatura anterior
 * desconhecida), cai numa estimativa de 35 dias antes do corte.
 */
export function getReconciliationWindow(faturasList, vencimento) {
  const sorted = [...faturasList].sort((a, b) => (a.vencimento < b.vencimento ? -1 : 1));
  const idx = sorted.findIndex((f) => f.vencimento === vencimento);
  const fatura = idx >= 0 ? sorted[idx] : null;
  const windowEnd = fatura && fatura.dataCorte ? new Date(fatura.dataCorte) : new Date(vencimento);
  const prev = idx > 0 ? sorted[idx - 1] : null;
  let windowStart;
  if (prev && prev.dataCorte) {
    windowStart = new Date(prev.dataCorte);
    windowStart.setDate(windowStart.getDate() + 1);
  } else {
    windowStart = new Date(windowEnd);
    windowStart.setDate(windowStart.getDate() - 35);
  }
  return { windowStart, windowEnd };
}

// Alguns lançamentos aparecem na fatura com a data de compra registrada um pouco fora do
// período de corte "oficial" dessa mesma fatura (posição/processamento irregular perto da
// borda do ciclo, aparentemente uma particularidade do próprio banco). Por isso o CONJUNTO de
// lançamentos candidatos a casar com uma fatura usa uma janela um pouco mais larga que a
// oficial — mas a precisão de qual linha casa com qual continua vindo da identidade
// (parcelamento) ou da proximidade de poucos dias com a data exata da linha (despesa), então
// essa folga não reintroduz confusão entre faturas vizinhas.
const POOL_SLACK_DAYS = 3;
function getPoolWindow(faturasList, vencimento) {
  const { windowStart, windowEnd } = getReconciliationWindow(faturasList, vencimento);
  const poolStart = new Date(windowStart); poolStart.setDate(poolStart.getDate() - POOL_SLACK_DAYS);
  const poolEnd = new Date(windowEnd); poolEnd.setDate(poolEnd.getDate() + POOL_SLACK_DAYS);
  return { poolStart, poolEnd };
}

/**
 * Monta os buckets exibidos na aba Conciliação para uma fatura (vencimento) específica:
 * conciliados automaticamente (parcelas confirmadas por identidade, sem toque nenhum),
 * conciliados manualmente, só na fatura (precisa de "+ lançar") e só no app. A marca de
 * "automático" é lida direto do lançamento (campo `conciliadoAutomaticamente`, gravado
 * permanentemente quando a confirmação acontece) — não depende de qual foi a última fatura
 * importada na sessão, então não se perde ao trocar de aba ou reabrir o app.
 */
export function runReconciliation(vencimento, faturasList, expenses) {
  const fatura = faturasList.find((f) => f.vencimento === vencimento);
  const items = fatura ? fatura.rows : [];
  const { windowStart, windowEnd } = getReconciliationWindow(faturasList, vencimento);
  const { poolStart, poolEnd } = getPoolWindow(faturasList, vencimento);
  // O pool de candidatos pra CASAR é um pouco mais largo que a janela oficial (cobre datas
  // registradas de forma irregular perto da borda do ciclo), mas o balde "só no app" só
  // mostra quem está DENTRO da janela oficial desta fatura — senão uma parcela já confirmada
  // pertencente à fatura vizinha (datada bem na borda) apareceria como ruído aqui também.
  const appPool = expenses
    .filter((e) => !e.previsto && new Date(e.data) >= poolStart && new Date(e.data) <= poolEnd)
    .map((e) => ({ ...e, used: false, dentroDaJanela: new Date(e.data) >= windowStart && new Date(e.data) <= windowEnd }));

  const autoMatched = [];
  const matched = [];
  const faturaUnmatched = [];

  items.forEach((item) => {
    let idx = -1;
    if (item.tipo === 'parcelamento') {
      // por identidade primeiro (mesma compra, independente do valor bater exato) — evita
      // casar com a linha errada quando duas parcelas diferentes têm o valor coincidindo. Com
      // o pool mais largo, pode haver MAIS de uma parcela já confirmada da mesma compra (uma
      // por mês) candidata ao mesmo tempo — por isso pega a de data mais próxima do vencimento
      // desta fatura, não só a primeira encontrada.
      const key = computeParcelaKey(item.descricao, item.data, item.parcela_total);
      idx = closestIndexByKey(appPool, key, item.vencimento);
      if (idx < 0) idx = appPool.findIndex((e) => !e.used && Math.abs(e.valor - item.valor) < 0.01);
    } else {
      idx = appPool.findIndex((e) => !e.used && Math.abs(e.valor - item.valor) < 0.01 && dateDiffDays(e.data, item.data) <= 2);
    }
    if (idx >= 0) {
      appPool[idx].used = true;
      const bucket = appPool[idx].conciliadoAutomaticamente ? autoMatched : matched;
      bucket.push({ fatura: item, app: appPool[idx] });
    } else {
      faturaUnmatched.push(item);
    }
  });
  const appUnmatched = appPool.filter((e) => !e.used && e.dentroDaJanela);

  return { autoMatched, matched, faturaUnmatched, appUnmatched };
}

/**
 * Monta a base pro "Exportar conciliação completa": percorre todas as faturas importadas
 * em ordem cronológica, casando cada lançamento da fatura com um lançamento real do app (o
 * mesmo critério usado na aba Conciliação) sem deixar um lançamento ser reaproveitado em
 * duas faturas diferentes. O que sobrar de lançamento real sem casar em nenhuma fatura vira
 * "Só no app".
 */
export function buildFullReconciliationRows(faturasList, allExpenses) {
  const pool = allExpenses.filter((e) => !e.previsto).map((e) => ({ ...e, used: false }));
  const rows = [];
  const sortedFaturas = [...faturasList].sort((a, b) => (a.vencimento < b.vencimento ? -1 : 1));

  sortedFaturas.forEach((fatura) => {
    const { poolStart, poolEnd } = getPoolWindow(faturasList, fatura.vencimento);
    fatura.rows.forEach((item) => {
      let idx = -1;
      if (item.tipo === 'parcelamento') {
        const key = computeParcelaKey(item.descricao, item.data, item.parcela_total);
        idx = closestIndexByKey(pool, key, item.vencimento);
        if (idx < 0) idx = pool.findIndex((e) => !e.used && new Date(e.data) >= poolStart && new Date(e.data) <= poolEnd && Math.abs(e.valor - item.valor) < 0.01);
      } else {
        idx = pool.findIndex((e) => !e.used && new Date(e.data) >= poolStart && new Date(e.data) <= poolEnd && Math.abs(e.valor - item.valor) < 0.01 && dateDiffDays(e.data, item.data) <= 2);
      }
      const parcela = item.parcela_atual ? `${item.parcela_atual}/${item.parcela_total}` : '';
      if (idx >= 0) {
        const e = pool[idx];
        e.used = true;
        rows.push({
          status: e.conciliadoAutomaticamente ? 'Conciliado (automático)' : 'Conciliado',
          vencimentoFatura: fatura.vencimento, dataFatura: item.data, descricaoFatura: item.descricao, parcela, valorFatura: item.valor,
          dataLancamento: e.data, descricaoLancamento: e.descricao, categoria: e.categoria, valorLancamento: e.valor,
        });
      } else {
        rows.push({
          status: 'Só na fatura',
          vencimentoFatura: fatura.vencimento, dataFatura: item.data, descricaoFatura: item.descricao, parcela, valorFatura: item.valor,
          dataLancamento: '', descricaoLancamento: '', categoria: '', valorLancamento: '',
        });
      }
    });
  });

  pool.filter((e) => !e.used).forEach((e) => {
    rows.push({
      status: 'Só no app',
      vencimentoFatura: '', dataFatura: '', descricaoFatura: '', parcela: '', valorFatura: '',
      dataLancamento: e.data, descricaoLancamento: e.descricao, categoria: e.categoria, valorLancamento: e.valor,
    });
  });

  rows.sort((a, b) => {
    const da = a.dataLancamento || a.dataFatura, db = b.dataLancamento || b.dataFatura;
    return da < db ? -1 : da > db ? 1 : 0;
  });
  return rows;
}
