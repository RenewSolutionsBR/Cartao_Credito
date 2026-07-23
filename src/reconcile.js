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
      months.push({ ym: ymOf(dt), label: dt.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }), valor: r.valor });
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
  const catId = (categories.find((c) => c.nome.toLowerCase() === 'parcelamentos') || {}).id;

  const toRemoveIds = existingExpenses.filter((e) => e.previsto).map((e) => e.id);

  const toAdd = [];
  groups.forEach((g) => {
    g.months.forEach((m) => {
      const safeKey = (g.descricao + '|' + m.valor.toFixed(2) + '|' + m.ym).replace(/[^a-zA-Z0-9]/g, '_');
      toAdd.push({
        id: 'seed_' + safeKey,
        descricao: `${g.descricao} (parcela prevista)`,
        valor: m.valor,
        data: m.ym + '-01',
        categoria: catId || 'outros',
        previsto: true,
        parcelaKey: g.key,
      });
    });
  });

  return { toAdd, toRemoveIds };
}

function dateDiffDays(iso1, iso2) {
  return Math.abs((new Date(iso1) - new Date(iso2)) / 86400000);
}

/**
 * Aplica a confirmação automática: para cada linha de parcelamento da fatura recém
 * importada, procura entre os lançamentos previstos com a MESMA identidade (descrição +
 * data da compra original + total de parcelas) qual tem a data prevista mais próxima do
 * vencimento real — não exige que caia no mesmo mês "nominal", porque o Santander às vezes
 * emite duas faturas dentro do mesmo mês (ex.: uma no dia 1 e outra no dia 30), o que faria
 * a segunda não achar nenhuma previsão pendente se a exigência fosse mês idêntico. Ao
 * confirmar, a data do lançamento passa a ser a do vencimento da fatura (mesma convenção
 * usada no "+ lançar" manual), pra ficar consistente e cair na janela de conciliação certa.
 */
export function autoConfirmParcelas(faturaRows, expenses) {
  const byId = new Map(expenses.map((e) => [e.id, e]));
  const confirmed = [];
  const usedIds = new Set();

  for (const row of faturaRows) {
    if (row.tipo !== 'parcelamento') continue;
    const key = computeParcelaKey(row.descricao, row.data, row.parcela_total);
    const candidates = expenses.filter((e) => e.previsto && e.parcelaKey === key && !usedIds.has(e.id));
    if (!candidates.length) continue;
    candidates.sort((a, b) => dateDiffDays(a.data, row.vencimento) - dateDiffDays(b.data, row.vencimento));
    const candidate = candidates[0];
    usedIds.add(candidate.id);
    const updated = { ...candidate, previsto: false, descricao: candidate.descricao.replace(/\s*\(parcela prevista\)\s*$/i, ''), valor: row.valor, data: row.vencimento, conciliadoAutomaticamente: true };
    byId.set(updated.id, updated);
    confirmed.push({ before: candidate, after: updated, faturaRow: row });
  }

  return { updatedExpenses: [...byId.values()], confirmed };
}

/**
 * Monta os buckets exibidos na aba Conciliação para uma fatura (vencimento) específica:
 * conciliados automaticamente (parcelas confirmadas por identidade, sem toque nenhum),
 * conciliados manualmente, só na fatura (precisa de "+ lançar") e só no app. A marca de
 * "automático" é lida direto do lançamento (campo `conciliadoAutomaticamente`, gravado
 * permanentemente quando a confirmação acontece) — não depende de qual foi a última fatura
 * importada na sessão, então não se perde ao trocar de aba ou reabrir o app.
 */
export function runReconciliation(vencimento, allFaturaRows, expenses) {
  const items = allFaturaRows.filter((r) => r.vencimento === vencimento);
  const windowStart = new Date(vencimento); windowStart.setDate(windowStart.getDate() - 40);
  const windowEnd = new Date(vencimento);
  const appPool = expenses
    .filter((e) => new Date(e.data) >= windowStart && new Date(e.data) <= windowEnd)
    .map((e) => ({ ...e, used: false }));

  const autoMatched = [];
  const matched = [];
  const faturaUnmatched = [];

  items.forEach((item) => {
    const idx = item.tipo === 'parcelamento'
      ? appPool.findIndex((e) => !e.used && Math.abs(e.valor - item.valor) < 0.01)
      : appPool.findIndex((e) => !e.used && Math.abs(e.valor - item.valor) < 0.01 && dateDiffDays(e.data, item.data) <= 2);
    if (idx >= 0) {
      appPool[idx].used = true;
      const bucket = appPool[idx].conciliadoAutomaticamente ? autoMatched : matched;
      bucket.push({ fatura: item, app: appPool[idx] });
    } else {
      faturaUnmatched.push(item);
    }
  });
  const appUnmatched = appPool.filter((e) => !e.used);

  return { autoMatched, matched, faturaUnmatched, appUnmatched };
}

/**
 * Monta a base pro "Exportar conciliação completa": percorre todas as faturas importadas
 * em ordem cronológica, casando cada lançamento da fatura com um lançamento real do app (o
 * mesmo critério usado na aba Conciliação) sem deixar um lançamento ser reaproveitado em
 * duas faturas diferentes — importante porque as janelas de ±40 dias de faturas vizinhas se
 * sobrepõem. O que sobrar de lançamento real sem casar em nenhuma fatura vira "Só no app".
 */
export function buildFullReconciliationRows(faturasList, allExpenses) {
  const pool = allExpenses.filter((e) => !e.previsto).map((e) => ({ ...e, used: false }));
  const rows = [];
  const sortedFaturas = [...faturasList].sort((a, b) => (a.vencimento < b.vencimento ? -1 : 1));

  sortedFaturas.forEach((fatura) => {
    const windowStart = new Date(fatura.vencimento); windowStart.setDate(windowStart.getDate() - 40);
    const windowEnd = new Date(fatura.vencimento);
    fatura.rows.forEach((item) => {
      const idx = item.tipo === 'parcelamento'
        ? pool.findIndex((e) => !e.used && new Date(e.data) >= windowStart && new Date(e.data) <= windowEnd && Math.abs(e.valor - item.valor) < 0.01)
        : pool.findIndex((e) => !e.used && new Date(e.data) >= windowStart && new Date(e.data) <= windowEnd && Math.abs(e.valor - item.valor) < 0.01 && dateDiffDays(e.data, item.data) <= 2);
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
