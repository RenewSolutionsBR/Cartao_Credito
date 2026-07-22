// Parser da fatura Santander Visa em PDF, 100% client-side (pdf.js), sem depender de IA.
//
// O layout de "Detalhamento da Fatura" às vezes usa 2 colunas lado a lado (quando há
// muitos lançamentos) e o pdf.js não garante ordem de leitura visual em getTextContent()
// para layouts assim. Por isso reconstruímos as linhas nós mesmos a partir da posição
// (x,y) de cada item de texto, em vez de confiar na ordem bruta devolvida pela lib:
//   1) detecta se a página tem 2 colunas (maior "vão" de x, centrado, com conteúdo dos
//      dois lados) — se não achar um vão assim, trata a página inteira como 1 coluna.
//   2) dentro de cada coluna, agrupa itens em linhas por proximidade de y, ordena por x.
//   3) concatena: coluna esquerda (de cima a baixo) então coluna direita.
// Esse algoritmo foi validado contra o texto bruto real de 8 faturas de exemplo do
// usuário (via extração de posição x/y equivalente) antes de ser ligado à UI.

let pdfjsLibPromise = null;
async function getPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('../vendor/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
      return lib;
    });
  }
  return pdfjsLibPromise;
}

function moneyToNumber(str) {
  return parseFloat(String(str).trim().replace(/\./g, '').replace(',', '.'));
}

const MONEY_RE = /-?\d{1,3}(?:\.\d{3})*,\d{2}/g;

function clusterRowsFromItems(items, yTol = 2.2) {
  const sorted = [...items].sort((a, b) => (b.y - a.y) || (a.x - b.x)); // topo->baixo, esq->dir (PDF: y cresce p/ cima)
  const rows = [];
  let cur = [];
  let curY = null;
  for (const it of sorted) {
    if (curY === null || Math.abs(it.y - curY) <= yTol) {
      cur.push(it);
      curY = curY === null ? it.y : curY;
    } else {
      rows.push(cur);
      cur = [it];
      curY = it.y;
    }
  }
  if (cur.length) rows.push(cur);
  return rows.map((r) => r.sort((a, b) => a.x - b.x).map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim());
}

const COMPLETE_ROW_RE = /^(?:\S+\s+)?\d{2}\/\d{2}\s+.+\d,\d{2}\s*$/;
const LABEL_LINE_RE = /^(Parcelamentos|Despesas|Pagamento e Demais|VALOR TOTAL|Compra\s+Data|RENE G FANTINI|@\s*RENE|Detalhamento da Fatura|Resumo da Fatura|IOF DESPESA)/i;

function scoreCompleteness(lines) {
  return lines.reduce((n, l) => n + ((COMPLETE_ROW_RE.test(l) || LABEL_LINE_RE.test(l)) ? 1 : 0), 0);
}

/**
 * Reconstrói linhas para um conjunto de itens, dividindo recursivamente em colunas sempre
 * que isso produzir estritamente mais linhas completas/reconhecidas do que manter junto.
 * Generaliza para 1, 2, 3+ colunas sem assumir uma posição fixa de corte, e evita cortar ao
 * meio uma tabela de coluna única (nesse caso o split sempre piora o score de completude).
 */
function reconstructSegment(items, depth = 0) {
  if (!items.length || depth > 4) return clusterRowsFromItems(items);
  const xs = [...new Set(items.map((it) => Math.round(it.x)))].sort((a, b) => a - b);
  const noSplitLines = clusterRowsFromItems(items);
  if (xs.length < 2) return noSplitLines;

  let bestLines = noSplitLines;
  let bestScore = scoreCompleteness(noSplitLines);

  for (let i = 0; i < xs.length - 1; i++) {
    const gap = xs[i + 1] - xs[i];
    if (gap < 35) continue;
    const mid = (xs[i] + xs[i + 1]) / 2;
    const left = items.filter((it) => it.x < mid);
    const right = items.filter((it) => it.x >= mid);
    if (left.length < 5 || right.length < 5) continue;
    const combined = [...reconstructSegment(left, depth + 1), ...reconstructSegment(right, depth + 1)];
    const combinedScore = scoreCompleteness(combined);
    if (combinedScore > bestScore) { bestLines = combined; bestScore = combinedScore; }
  }
  return bestLines;
}

/**
 * Reconstrói as linhas de uma página, recortando só a faixa vertical ACIMA de "Detalhamento
 * da Fatura" (caixas de resumo/propaganda no topo) e ABAIXO de "Juros e Custo Efetivo Total"
 * (rodapé jurídico + caixa de contato, que tem seu próprio layout em colunas). Não corta em
 * "Resumo da Fatura" diretamente: numa fatura curta, a coluna mais curta pode chegar nesse
 * texto numa altura que ainda está no meio do conteúdo da coluna mais longa ao lado — cortar
 * ali perderia linhas legítimas. "Juros e Custo Efetivo Total" só aparece depois que TODAS as
 * colunas (e o próprio Resumo, sempre em coluna única) já convergiram, então é um limite
 * inferior seguro. A própria máquina de estados do parser já para em "Resumo da Fatura" na
 * hora certa, uma vez que a ordem final (coluna esquerda inteira, depois direita inteira)
 * preserva a sequência lógica.
 */
function reconstructPageLines(items, alreadyInDetail) {
  if (!items.length) return { lines: [], stillInDetail: alreadyInDetail };

  const rough = clusterRowsWithY(items);
  let yTop = null;
  let yFooter = null;
  for (const { y, text } of rough) {
    if (/Detalhamento da Fatura/i.test(text)) yTop = yTop === null ? y : Math.max(yTop, y);
    if (/Juros e Custo Efetivo Total/i.test(text)) yFooter = yFooter === null ? y : Math.max(yFooter, y);
  }

  const inDetailAtStart = alreadyInDetail || yTop !== null;
  if (!inDetailAtStart) return { lines: [], stillInDetail: false };

  const hi = yTop !== null ? yTop + 3 : Math.max(...items.map((it) => it.y)) + 1;
  const lo = yFooter !== null ? yFooter + 3 : Math.min(...items.map((it) => it.y)) - 1;
  const bandItems = items.filter((it) => it.y >= lo && it.y <= hi);

  let lines = reconstructSegment(bandItems);
  if (yTop !== null) lines = ['Detalhamento da Fatura', ...lines];
  return { lines, stillInDetail: true };
}

function clusterRowsWithY(items, yTol = 2.2) {
  const sorted = [...items].sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const rows = [];
  let cur = [];
  let curY = null;
  for (const it of sorted) {
    if (curY === null || Math.abs(it.y - curY) <= yTol) {
      cur.push(it);
      curY = curY === null ? it.y : curY;
    } else {
      rows.push({ y: curY, items: cur });
      cur = [it];
      curY = it.y;
    }
  }
  if (cur.length) rows.push({ y: curY, items: cur });
  return rows.map(({ y, items: r }) => ({ y, text: r.sort((a, b) => a.x - b.x).map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim() }));
}

async function extractLines(arrayBuffer) {
  const pdfjsLib = await getPdfjs();
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const allLines = [];
  let inDetail = false;
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    const items = content.items
      .filter((it) => it.str && it.str.trim().length > 0)
      .map((it) => ({ str: it.str.trim(), x: it.transform[4], y: it.transform[5] }));
    const { lines, stillInDetail } = reconstructPageLines(items, inDetail);
    inDetail = stillInDetail;
    allLines.push(...lines);
    if (lines.some((l) => /^Resumo da Fatura/i.test(l.trim()))) break;
  }
  return allLines;
}

// Resolve o ano de uma data DD/MM dada como referência o vencimento da fatura: escolhe o
// ano mais recente que não fique DEPOIS do vencimento (+5 dias de folga) — cobre tanto
// despesas do próprio ciclo quanto a data de compra original de parcelamentos antigos
// (até ~12 meses atrás), sem precisar hardcodar limites de mês.
function resolveDate(dd, mm, vencimento) {
  const slack = new Date(vencimento);
  slack.setDate(slack.getDate() + 5);
  for (let back = 0; back <= 3; back++) {
    const year = vencimento.getFullYear() - back;
    const candidate = new Date(year, mm - 1, dd);
    if (!isNaN(candidate) && candidate <= slack) return candidate;
  }
  return new Date(vencimento.getFullYear(), mm - 1, dd);
}

function toISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function vencimentoFromFilename(filename) {
  const m = /Visa-(\d{2})-(\d{2})-(\d{4})\.pdf$/i.exec(filename || '');
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));
}

function vencimentoFromText(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/^Vencimento$/i.test(lines[i].trim())) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(lines[j]);
        if (m) return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
      }
    }
    const inline = /Vencimento\D+(\d{2})\/(\d{2})\/(\d{4})/i.exec(lines[i]);
    if (inline) return new Date(parseInt(inline[3]), parseInt(inline[2]) - 1, parseInt(inline[1]));
  }
  return null;
}

const CARD_HEADER_RE = /XXXX\s*XXXX\s*(\d{4})\s*$/;
const ROW_RE = /^(?:\S+\s+)?(\d{2})\/(\d{2})\s+(.+)$/;
const PARCELA_TAG_RE = /(\d{2})\/(\d{2})\s*$/; // capturado à parte, DEPOIS de remover os valores em R$/US$ do fim

/**
 * Faz o parsing completo de uma fatura em PDF.
 * @returns {{vencimento:string, arquivo:string, rows:Array, checksum:{ok:boolean, sections:Array}, warnings:string[]}}
 */
export async function parseFaturaPdf(arrayBuffer, filename) {
  const lines = await extractLines(arrayBuffer);
  const warnings = [];

  let vencimentoDate = vencimentoFromFilename(filename);
  if (!vencimentoDate) {
    vencimentoDate = vencimentoFromText(lines);
    if (vencimentoDate) warnings.push('Vencimento extraído do texto do PDF (nome do arquivo não seguia o padrão "Visa-DD-MM-AAAA.pdf").');
  }
  if (!vencimentoDate) {
    throw new Error('Não consegui identificar a data de vencimento desta fatura (nem pelo nome do arquivo, nem pelo texto). Renomeie o arquivo para o padrão "Visa-DD-MM-AAAA.pdf" (data do vencimento) e tente de novo.');
  }

  const rows = [];
  const sections = []; // checksum por bloco de cartão: {cardEnding, expected, computed, ok}
  let mode = null; // null | 'credito' | 'parcelamento' | 'despesa'
  let inDetalhamento = false;
  let cardEnding = null;
  let sectionSum = 0;
  let lastDate = null; // p/ linhas "IOF DESPESA NO EXTERIOR" sem data própria

  const flushSection = (expected) => {
    const ok = Math.abs(sectionSum - expected) < 0.02;
    sections.push({ cardEnding, expected, computed: Math.round(sectionSum * 100) / 100, ok });
    if (!ok) warnings.push(`Cartão final ${cardEnding}: soma calculada (R$ ${sectionSum.toFixed(2)}) não bate com o "VALOR TOTAL" da fatura (R$ ${expected.toFixed(2)}).`);
    sectionSum = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/Detalhamento da Fatura/i.test(line)) { inDetalhamento = true; continue; }
    if (!inDetalhamento) continue;
    if (/^Resumo da Fatura/i.test(line)) break; // fim do detalhamento, resto é rodapé/legal

    const cardMatch = CARD_HEADER_RE.exec(line);
    if (cardMatch) { cardEnding = cardMatch[1]; mode = null; continue; }

    if (/^Pagamento e Demais/i.test(line)) { mode = 'credito'; continue; }
    if (/^Parcelamentos\s*$/i.test(line)) { mode = 'parcelamento'; continue; }
    if (/^Despesas\s*$/i.test(line)) { mode = 'despesa'; continue; }
    if (/^Compra\s+Data\s+Descri/i.test(line)) continue; // cabeçalho de coluna repetido

    const totalMatch = /^VALOR TOTAL\s+(-?[\d.,]+)/i.exec(line);
    if (totalMatch) { flushSection(moneyToNumber(totalMatch[1])); mode = null; continue; }

    if (mode === null) continue;

    if (/^COTA[ÇC][ÃA]O/i.test(line)) continue; // linha informativa de câmbio, descartar

    // "IOF DESPESA NO EXTERIOR <valor>" não tem data própria: herda a última data vista.
    const iofMatch = /^IOF DESPESA NO EXTERIOR\s+([\d.,]+)/i.exec(line);
    if (iofMatch) {
      if (!lastDate) { warnings.push(`Linha de IOF sem lançamento anterior para herdar a data: "${line}"`); continue; }
      const valor = moneyToNumber(iofMatch[1]);
      if (mode !== 'credito') {
        sectionSum += valor;
        rows.push({ tipo: 'despesa', vencimento: toISO(vencimentoDate), data: toISO(lastDate), descricao: 'IOF DESPESA NO EXTERIOR', valor, arquivo: filename, parcela_atual: null, parcela_total: null, cardEnding });
      }
      continue;
    }

    const rowMatch = ROW_RE.exec(line);
    if (!rowMatch) continue; // linha não reconhecida dentro de uma seção: ignorada (o checksum vai acusar se isso comeu um valor)

    const [, ddStr, mmStr, rest] = rowMatch;
    const dd = parseInt(ddStr, 10);
    const mm = parseInt(mmStr, 10);
    if (dd < 1 || dd > 31 || mm < 1 || mm > 12) continue;

    const moneyTokens = rest.match(MONEY_RE);
    if (!moneyTokens || moneyTokens.length === 0) continue;

    // a descrição é tudo antes do primeiro token monetário (o(s) valor(es) ficam sempre no fim da linha)
    const firstMoneyIdx = rest.indexOf(moneyTokens[0]);
    let descAndMaybeParcela = rest.slice(0, firstMoneyIdx).trim();

    let parcelaAtual = null, parcelaTotal = null;
    const parcelaMatch = PARCELA_TAG_RE.exec(descAndMaybeParcela);
    if (parcelaMatch) {
      parcelaAtual = parseInt(parcelaMatch[1], 10);
      parcelaTotal = parseInt(parcelaMatch[2], 10);
      descAndMaybeParcela = descAndMaybeParcela.slice(0, parcelaMatch.index).trim();
    }
    const descricao = descAndMaybeParcela.replace(/\s+/g, ' ').trim();
    if (!descricao) continue;

    // 1 token = só R$; 2 = R$ + US$; 3 = valor-moeda-estrangeira + R$ + US$ (compra internacional)
    let valor;
    if (moneyTokens.length >= 3) valor = moneyToNumber(moneyTokens[moneyTokens.length - 2]);
    else valor = moneyToNumber(moneyTokens[0]);

    const dataResolvida = resolveDate(dd, mm, vencimentoDate);
    lastDate = dataResolvida;

    if (mode === 'credito') continue; // pagamentos/créditos não entram como lançamento

    const tipo = parcelaAtual != null ? 'parcelamento' : 'despesa';
    sectionSum += valor;
    rows.push({
      tipo,
      vencimento: toISO(vencimentoDate),
      data: toISO(dataResolvida),
      descricao,
      valor,
      arquivo: filename,
      parcela_atual: parcelaAtual,
      parcela_total: parcelaTotal,
      cardEnding,
    });
  }

  const checksum = { ok: sections.length > 0 && sections.every((s) => s.ok), sections };
  if (sections.length === 0) warnings.push('Não encontrei nenhuma seção "VALOR TOTAL" pra conferir — não foi possível validar esta fatura automaticamente.');

  return { vencimento: toISO(vencimentoDate), arquivo: filename, rows, checksum, warnings };
}
