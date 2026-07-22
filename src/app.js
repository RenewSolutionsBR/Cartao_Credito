import * as storage from './storage.js';
import { parseFaturaPdf } from './pdf-parser.js';
import { computeParcelaGroups, buildFuturePredictions, autoConfirmParcelas, runReconciliation } from './reconcile.js';

const DEFAULT_CATEGORIES = [
  { id: 'alimentacao', nome: 'Alimentação', cor: '#7A8B69' },
  { id: 'transporte', nome: 'Transporte', cor: '#5B7C99' },
  { id: 'saude', nome: 'Saúde', cor: '#B2694F' },
  { id: 'lazer', nome: 'Lazer', cor: '#8B6B8F' },
  { id: 'casa', nome: 'Casa', cor: '#C9A227' },
  { id: 'viagens', nome: 'Viagens', cor: '#5C8B8B' },
  { id: 'pessoal', nome: 'Pessoal', cor: '#6E7FB0' },
  { id: 'parcelamentos', nome: 'Parcelamentos', cor: '#9C8248' },
  { id: 'outros', nome: 'Outros', cor: '#8A8578' },
];
const PALETTE = ['#7A8B69', '#5B7C99', '#B2694F', '#8B6B8F', '#C9A227', '#8A8578', '#5C8B8B', '#A65A5A', '#6E7FB0', '#9C8248'];

let expenses = [];
let categories = [];
let faturasList = []; // [{vencimento, arquivo, rows, importedAt}]
let editingId = null;
let currentVencimento = null;
let vindoDaConciliacao = false;
let lastAutoConfirmedIds = new Set();
let pendingImport = null; // { vencimento, arquivo, rows, checksum, warnings, fromXlsx }

let viewDate = new Date();
viewDate.setDate(1);

function allFaturaRows() { return faturasList.flatMap((f) => f.rows); }

function fmtBRL(n) { return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function parseMoneyBR(str) {
  if (str == null) return NaN;
  str = String(str).trim();
  if (str === '') return NaN;
  if (str.includes(',')) { str = str.replace(/\./g, '').replace(',', '.'); }
  return parseFloat(str);
}
function monthKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function monthLabelStr(d) { return d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); }
function todayISO() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function catById(id) { return categories.find((c) => c.id === id); }
function setStatus(msg, elId) { const el = document.getElementById(elId || 'statusMsg'); el.textContent = msg; if (msg) setTimeout(() => { el.textContent = ''; }, 4000); }

/* ---------- Carregamento inicial ---------- */
async function loadAll() {
  expenses = await storage.getAll('expenses');
  categories = await storage.getAll('categories');
  if (categories.length === 0) {
    categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    await storage.putMany('categories', categories);
  }
  faturasList = await storage.getAll('faturas');
  renderCategorySelect(); renderCatPanel(); renderDescList(); render();
  await renderLastBackupHint();
  refreshFaturaSelect();
  if (faturasList.length) {
    currentVencimento = faturasList.map((f) => f.vencimento).sort().slice(-1)[0];
    displayReconciliation(currentVencimento);
  }
}

/* ---------- Categorias ---------- */
function renderCategorySelect() {
  const sel = document.getElementById('categoria');
  const prev = sel.value;
  sel.innerHTML = categories.map((c) => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join('');
  if (categories.some((c) => c.id === prev)) sel.value = prev;
}
function renderCatPanel() {
  const list = document.getElementById('catList');
  list.innerHTML = categories.map((c) => `
    <div class="cat-item-row" data-id="${c.id}">
      <span class="dot" style="background:${c.cor}"></span>
      <input type="text" value="${escapeHtml(c.nome)}" data-id="${c.id}" class="cat-rename">
      <button type="button" class="cat-del" data-id="${c.id}" aria-label="Excluir categoria">✕</button>
    </div>`).join('');
  list.querySelectorAll('.cat-rename').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const c = catById(inp.dataset.id);
      if (c && inp.value.trim()) { c.nome = inp.value.trim(); await storage.put('categories', c); renderCategorySelect(); render(); }
    });
  });
  list.querySelectorAll('.cat-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (categories.length <= 1) { setStatus('Mantenha ao menos uma categoria.'); return; }
      categories = categories.filter((c) => c.id !== btn.dataset.id);
      await storage.remove('categories', btn.dataset.id);
      renderCategorySelect(); renderCatPanel(); render();
    });
  });
}
document.getElementById('toggleCatPanel').addEventListener('click', () => document.getElementById('catPanel').classList.toggle('open'));
document.getElementById('addCatBtn').addEventListener('click', async () => {
  const input = document.getElementById('newCatName');
  const nome = input.value.trim();
  if (!nome) return;
  const id = 'cat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const cor = PALETTE[categories.length % PALETTE.length];
  const cat = { id, nome, cor };
  categories.push(cat);
  input.value = '';
  await storage.put('categories', cat);
  renderCategorySelect(); renderCatPanel();
  document.getElementById('categoria').value = id;
});

function renderDescList() {
  const freq = {};
  expenses.forEach((e) => { freq[e.descricao] = (freq[e.descricao] || 0) + 1; });
  const sorted = Object.keys(freq).sort((a, b) => freq[b] - freq[a] || a.localeCompare(b));
  document.getElementById('descList').innerHTML = sorted.map((d) => `<option value="${escapeHtml(d)}"></option>`).join('');
}

/* ---------- Lançamentos ---------- */
function render() {
  document.getElementById('monthLabel').textContent = monthLabelStr(viewDate);
  const mk = monthKey(viewDate);
  const monthExpenses = expenses.filter((e) => e.data.slice(0, 7) === mk).sort((a, b) => (a.data < b.data ? 1 : -1));
  const total = monthExpenses.reduce((s, e) => s + e.valor, 0);
  document.getElementById('monthTotal').textContent = fmtBRL(total);
  document.getElementById('monthCount').textContent = monthExpenses.length;
  const totalReal = expenses.filter((e) => !e.previsto).length;
  document.getElementById('totalCountLabel').textContent = `total: ${totalReal} (todos os meses)`;

  const listEl = document.getElementById('entriesList');
  if (monthExpenses.length === 0) {
    listEl.innerHTML = expenses.length === 0
      ? '<div class="empty-state">Nenhum lançamento ainda. Se você tem um backup do app antigo, toque em "📥 Importar backup" abaixo.</div>'
      : '<div class="empty-state">Nenhum lançamento neste mês ainda.</div>';
    return;
  }
  const byDay = {};
  monthExpenses.forEach((e) => { (byDay[e.data] = byDay[e.data] || []).push(e); });

  let html = '';
  Object.keys(byDay).sort((a, b) => (a < b ? 1 : -1)).forEach((day) => {
    const dObj = new Date(day + 'T00:00:00');
    const dayLabel = dObj.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
    html += `<div class="day-group"><div class="day-label">${dayLabel}</div>`;
    byDay[day].forEach((e) => {
      const cat = catById(e.categoria);
      const catNome = cat ? cat.nome : 'Sem categoria';
      const catCor = cat ? cat.cor : 'var(--grey)';
      html += `
        <div class="entry-row" data-id="${e.id}">
          <span class="dot" style="background:${catCor}"></span>
          <span class="desc">${escapeHtml(e.descricao)}<span class="cat">${escapeHtml(catNome)}</span></span>
          <span class="amt">${fmtBRL(e.valor)}</span>
          <button class="edit" data-id="${e.id}" aria-label="Editar">✎</button>
          <button class="del" data-id="${e.id}" aria-label="Excluir">✕</button>
        </div>`;
    });
    html += `</div>`;
  });
  listEl.innerHTML = html;
  listEl.querySelectorAll('.del').forEach((btn) => btn.addEventListener('click', () => deleteEntry(btn.dataset.id)));
  listEl.querySelectorAll('.edit').forEach((btn) => btn.addEventListener('click', () => startEdit(btn.dataset.id)));
}

async function deleteEntry(id) {
  if (editingId === id) cancelEdit();
  expenses = expenses.filter((e) => e.id !== id);
  await storage.remove('expenses', id);
  render(); renderDescList();
  if (currentVencimento) displayReconciliation(currentVencimento);
}

function startEdit(id) {
  const e = expenses.find((x) => x.id === id);
  if (!e) return;
  editingId = id;
  document.getElementById('desc').value = e.descricao;
  document.getElementById('valor').value = e.valor;
  document.getElementById('data').value = e.data;
  document.getElementById('categoria').value = e.categoria;
  document.getElementById('submitBtn').textContent = 'Salvar alterações';
  document.getElementById('cancelEditBtn').style.display = 'block';
  document.getElementById('editingBanner').style.display = 'block';
  document.getElementById('entryForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function cancelEdit() {
  editingId = null;
  vindoDaConciliacao = false;
  document.getElementById('entryForm').reset();
  document.getElementById('data').value = todayISO();
  document.getElementById('submitBtn').textContent = 'Lançar gasto';
  document.getElementById('cancelEditBtn').style.display = 'none';
  document.getElementById('editingBanner').style.display = 'none';
}
document.getElementById('cancelEditBtn').addEventListener('click', cancelEdit);

function addMonthsClamped(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const daysInTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, daysInTarget));
  return target.getFullYear() + '-' + String(target.getMonth() + 1).padStart(2, '0') + '-' + String(target.getDate()).padStart(2, '0');
}
function splitParcelas(total, n) {
  const totalCents = Math.round(total * 100);
  const baseCents = Math.floor(totalCents / n);
  const remainder = totalCents - baseCents * n;
  const vals = [];
  for (let i = 0; i < n; i++) vals.push((baseCents + (i < remainder ? 1 : 0)) / 100);
  return vals;
}

function updateParcelaPreview() {
  const total = parseMoneyBR(document.getElementById('valorTotalParcelado').value);
  const n = parseInt(document.getElementById('numParcelas').value);
  const preview = document.getElementById('previewParcela');
  if (!isNaN(total) && n >= 2) {
    const vals = splitParcelas(total, n);
    preview.textContent = `${n}x de ${fmtBRL(vals[0])} (total ${fmtBRL(total)}) — um lançamento por mês a partir da data escolhida.`;
    preview.style.display = 'block';
  } else {
    preview.style.display = 'none';
  }
}
document.getElementById('isParcelado').addEventListener('change', (ev) => {
  const on = ev.target.checked;
  document.getElementById('fieldValorSimples').style.display = on ? 'none' : 'block';
  document.getElementById('fieldValorTotal').style.display = on ? 'block' : 'none';
  document.getElementById('fieldNumParcelas').style.display = on ? 'block' : 'none';
  document.getElementById('valor').required = !on;
  document.getElementById('valorTotalParcelado').required = on;
  document.getElementById('numParcelas').required = on;
  if (!on) document.getElementById('previewParcela').style.display = 'none';
});
document.getElementById('valorTotalParcelado').addEventListener('input', updateParcelaPreview);
document.getElementById('numParcelas').addEventListener('input', updateParcelaPreview);

document.getElementById('submitBtn').addEventListener('click', async () => {
  try {
    const desc = document.getElementById('desc').value.trim();
    const data = document.getElementById('data').value;
    const categoria = document.getElementById('categoria').value;
    const parcelado = document.getElementById('isParcelado').checked;

    if (parcelado && !editingId) {
      const total = parseMoneyBR(document.getElementById('valorTotalParcelado').value);
      const n = parseInt(document.getElementById('numParcelas').value);
      if (!desc) { setStatus('Preencha a descrição.'); return; }
      if (!data) { setStatus('Preencha a data.'); return; }
      if (isNaN(total)) { setStatus('Valor total inválido — use vírgula ou ponto, ex: 1200,00.'); return; }
      if (!n || n < 2) { setStatus('Número de parcelas precisa ser 2 ou mais.'); return; }
      const vals = splitParcelas(total, n);
      const grupoId = 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const novos = [];
      for (let i = 0; i < n; i++) {
        novos.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + i,
          descricao: `${desc} (${i + 1}/${n})`,
          valor: vals[i],
          data: addMonthsClamped(data, i),
          categoria,
          grupo_parcela: grupoId,
        });
      }
      expenses.push(...novos);
      await storage.putMany('expenses', novos);
      document.getElementById('entryForm').reset();
      document.getElementById('data').value = todayISO();
      document.getElementById('isParcelado').dispatchEvent(new Event('change'));
      setStatus(`${n} parcelas lançadas, uma por mês.`);
      const [y, m] = data.split('-');
      viewDate = new Date(parseInt(y), parseInt(m) - 1, 1);
      render(); renderDescList();
      if (currentVencimento) displayReconciliation(currentVencimento);
      return;
    }

    const valor = parseMoneyBR(document.getElementById('valor').value);
    if (!desc) { setStatus('Preencha a descrição.'); return; }
    if (!data) { setStatus('Preencha a data.'); return; }
    if (isNaN(valor)) { setStatus('Valor inválido — use vírgula ou ponto, ex: 52,11.'); return; }

    if (editingId) {
      const e = expenses.find((x) => x.id === editingId);
      if (e) { e.descricao = desc; e.valor = valor; e.data = data; e.categoria = categoria; await storage.put('expenses', e); }
      cancelEdit();
      setStatus('Lançamento atualizado.');
    } else {
      const novo = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), descricao: desc, valor, data, categoria };
      expenses.push(novo);
      await storage.put('expenses', novo);
      document.getElementById('entryForm').reset();
      document.getElementById('data').value = todayISO();
      setStatus('Lançamento salvo.');
    }
    const [y, m] = data.split('-');
    viewDate = new Date(parseInt(y), parseInt(m) - 1, 1);
    render(); renderDescList();
    if (currentVencimento) displayReconciliation(currentVencimento);
    if (vindoDaConciliacao) {
      vindoDaConciliacao = false;
      document.querySelector('.tab-btn[data-tab="Conciliacao"]').click();
    }
  } catch (err) {
    setStatus('Erro ao lançar: ' + err.message);
  }
});

document.getElementById('prevMonth').addEventListener('click', () => { viewDate.setMonth(viewDate.getMonth() - 1); render(); });
document.getElementById('nextMonth').addEventListener('click', () => { viewDate.setMonth(viewDate.getMonth() + 1); render(); });

/* ---------- Export / backup ---------- */
async function offerDownload(wb, filename) {
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  try {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      setStatus('Compartilhado — escolha onde salvar.');
      return;
    }
  } catch (e) { /* usuário cancelou o share, cai no link abaixo */ }
  const url = URL.createObjectURL(blob);
  const link = document.getElementById('downloadLink');
  link.href = url;
  link.download = filename;
  link.textContent = `⬇️ Toque aqui para baixar: ${filename}`;
  document.getElementById('downloadLinkArea').style.display = 'block';
  setStatus('Arquivo pronto — toque no link acima pra baixar.');
}

document.getElementById('exportBtn').addEventListener('click', () => {
  const mk = monthKey(viewDate);
  const monthExpenses = expenses.filter((e) => e.data.slice(0, 7) === mk).sort((a, b) => (a.data < b.data ? -1 : 1));
  if (monthExpenses.length === 0) { setStatus('Nada para exportar neste mês.'); return; }
  const rows = monthExpenses.map((e) => ({ Data: e.data, Descrição: e.descricao, Categoria: (catById(e.categoria) || {}).nome || e.categoria, Valor: e.valor }));
  const total = monthExpenses.reduce((s, e) => s + e.valor, 0);
  rows.push({ Data: '', Descrição: '', Categoria: 'TOTAL', Valor: total });
  const byCat = {};
  monthExpenses.forEach((e) => { byCat[e.categoria] = (byCat[e.categoria] || 0) + e.valor; });
  const summaryRows = Object.keys(byCat).map((c) => ({ Categoria: (catById(c) || {}).nome || c, Total: byCat[c] }));
  summaryRows.push({ Categoria: 'TOTAL GERAL', Total: total });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Lançamentos');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Resumo por categoria');
  offerDownload(wb, `gastos-${mk}.xlsx`);
});

document.getElementById('backupBtn').addEventListener('click', async () => {
  if (expenses.length === 0 && categories.length === 0) { setStatus('Nada para fazer backup ainda.'); return; }
  const lancRows = expenses.map((e) => ({ id: e.id, descricao: e.descricao, valor: e.valor, data: e.data, categoria: e.categoria, previsto: e.previsto ? 1 : 0, parcelaKey: e.parcelaKey || '' }));
  const catRows = categories.map((c) => ({ id: c.id, nome: c.nome, cor: c.cor }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lancRows), 'Backup_Lancamentos');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(catRows), 'Backup_Categorias');
  await offerDownload(wb, `backup-livro-de-gastos-${todayISO()}.xlsx`);
  await storage.setMeta('lastBackupAt', Date.now());
  renderLastBackupHint();
});

function excelDateToISO(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400 * 1000)); return d.toISOString().slice(0, 10); }
  if (typeof v === 'string' && v.length >= 8) return v.slice(0, 10);
  return null;
}

document.getElementById('importBackupFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wbk = XLSX.read(buf, { type: 'array', cellDates: true });
    if (!wbk.SheetNames.includes('Backup_Lancamentos')) {
      setStatus('Esse arquivo não parece ser um backup completo (use o botão "Backup completo").');
      return;
    }
    const lancJson = XLSX.utils.sheet_to_json(wbk.Sheets['Backup_Lancamentos'], { defval: null });
    const catJson = wbk.SheetNames.includes('Backup_Categorias') ? XLSX.utils.sheet_to_json(wbk.Sheets['Backup_Categorias'], { defval: null }) : [];

    const existingCatIds = new Set(categories.map((c) => c.id));
    const newCats = [];
    catJson.forEach((r) => {
      if (r.id && !existingCatIds.has(String(r.id))) {
        const c = { id: String(r.id), nome: r.nome || String(r.id), cor: r.cor || PALETTE[categories.length % PALETTE.length] };
        categories.push(c); newCats.push(c); existingCatIds.add(c.id);
      }
    });

    const existingIds = new Set(expenses.map((e) => e.id));
    const newExp = [];
    lancJson.forEach((r) => {
      const id = r.id != null ? String(r.id) : null;
      if (id && !existingIds.has(id)) {
        const e = { id, descricao: r.descricao || '', valor: parseFloat(r.valor) || 0, data: excelDateToISO(r.data), categoria: r.categoria || 'outros' };
        if (r.previsto) e.previsto = true;
        if (r.parcelaKey) e.parcelaKey = r.parcelaKey;
        expenses.push(e); newExp.push(e); existingIds.add(id);
      }
    });

    await storage.putMany('categories', newCats);
    await storage.putMany('expenses', newExp);
    renderCategorySelect(); renderCatPanel(); renderDescList(); render();
    if (currentVencimento) displayReconciliation(currentVencimento);
    setStatus(`${newExp.length} lançamentos e ${newCats.length} categorias restaurados do backup.`);
  } catch (e) {
    setStatus('Não consegui ler esse backup: ' + e.message);
  }
  ev.target.value = '';
});

async function renderLastBackupHint() {
  const ts = await storage.getMeta('lastBackupAt');
  const el = document.getElementById('lastBackupHint');
  if (!ts) { el.textContent = 'Você ainda não fez nenhum backup completo.'; return; }
  const days = Math.floor((Date.now() - ts) / 86400000);
  el.textContent = days === 0 ? 'Último backup: hoje.' : `Último backup: há ${days} dia${days === 1 ? '' : 's'}.`;
}

/* ---------- Tabs ---------- */
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab' + btn.dataset.tab).classList.add('active');
    document.getElementById('monthPickerWrap').style.display = btn.dataset.tab === 'Lancamentos' ? 'flex' : 'none';
    if (btn.dataset.tab === 'Parcelas') renderParcelas();
    if (btn.dataset.tab === 'Conciliacao' && currentVencimento) displayReconciliation(currentVencimento);
  });
});

/* ---------- Importação de fatura em PDF ---------- */
function refreshFaturaSelect() {
  const vencs = [...new Set(faturasList.map((f) => f.vencimento))].sort();
  const sel = document.getElementById('rcFaturaSelect');
  sel.innerHTML = vencs.map((v) => {
    const label = new Date(v + 'T00:00:00').toLocaleDateString('pt-BR');
    const arq = (faturasList.find((f) => f.vencimento === v) || {}).arquivo || '';
    return `<option value="${v}">Vencimento ${label} (${escapeHtml(arq)})</option>`;
  }).join('');
  document.getElementById('rcSelectWrap').classList.toggle('show', vencs.length > 0);
  if (vencs.length && !vencs.includes(currentVencimento)) sel.value = vencs[vencs.length - 1];
}
document.getElementById('rcFaturaSelect').addEventListener('change', (ev) => { currentVencimento = ev.target.value; displayReconciliation(currentVencimento); });

document.getElementById('fileFaturaPdf').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const result = await parseFaturaPdf(buf, file.name);
    pendingImport = { ...result, fromXlsx: false };
    openPreview(pendingImport);
  } catch (e) {
    setStatus('Não consegui ler esse PDF: ' + e.message, 'rcStatusMsg');
  }
  ev.target.value = '';
});

function parseFaturaJsonRows(json, arquivoFallback) {
  return json.filter((r) => r.tipo === 'despesa' || r.tipo === 'parcelamento').map((r) => ({
    tipo: r.tipo,
    vencimento: excelDateToISO(r.vencimento_fatura),
    data: excelDateToISO(r.data_lancamento),
    descricao: r.descricao || '',
    valor: parseFloat(r.valor_rs) || 0,
    arquivo: r.arquivo_pdf || arquivoFallback || '',
    parcela_atual: r.parcela_atual != null ? parseInt(r.parcela_atual) : null,
    parcela_total: r.parcela_total != null ? parseInt(r.parcela_total) : null,
  })).filter((r) => r.vencimento && r.data);
}

document.getElementById('fileFatura').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const wbk = XLSX.read(buf, { type: 'array', cellDates: true });
    const sheetName = wbk.SheetNames.includes('Lancamentos') ? 'Lancamentos' : wbk.SheetNames[0];
    const json = XLSX.utils.sheet_to_json(wbk.Sheets[sheetName], { defval: null });
    const rows = parseFaturaJsonRows(json, file.name);
    if (!rows.length) { setStatus('Não achei lançamentos reconhecíveis nessa planilha.', 'rcStatusMsg'); return; }
    const vencimento = rows[0].vencimento;
    await commitFaturaImport({ vencimento, arquivo: file.name, rows, checksum: { ok: true, sections: [] }, warnings: [] });
  } catch (e) {
    setStatus('Não consegui ler esse arquivo: ' + e.message, 'rcStatusMsg');
  }
  ev.target.value = '';
});

function openPreview(imp) {
  document.getElementById('previewTitle').textContent = `Fatura de ${new Date(imp.vencimento + 'T00:00:00').toLocaleDateString('pt-BR')} — ${imp.arquivo}`;
  const banner = document.getElementById('previewChecksumBanner');
  const confirmBtn = document.getElementById('previewConfirmBtn');
  if (imp.checksum.ok) {
    banner.className = 'checksum-banner ok';
    banner.textContent = `Conferido — os valores batem com o total declarado na fatura (${imp.checksum.sections.length} seção/seções).`;
    confirmBtn.disabled = false;
  } else {
    banner.className = 'checksum-banner fail';
    banner.textContent = 'Atenção: a soma calculada não bateu com o total da fatura. Revise as linhas abaixo antes de importar — pode faltar algo.' + (imp.warnings.length ? ' ' + imp.warnings[0] : '');
    confirmBtn.disabled = true;
  }
  const body = document.getElementById('previewBody');
  body.innerHTML = imp.rows.map((r) => `
    <div class="preview-row">
      <span class="pv-date">${new Date(r.data + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span>
      <span class="pv-desc">${escapeHtml(r.descricao)}</span>
      <span class="pv-parc">${r.parcela_atual ? r.parcela_atual + '/' + r.parcela_total : ''}</span>
      <span class="pv-val">${fmtBRL(r.valor)}</span>
    </div>`).join('') || '<div class="empty-state">Nenhum lançamento reconhecido nesta fatura.</div>';

  if (!imp.checksum.ok) {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:0.78rem;color:var(--danger);padding:8px 0 0;';
    wrap.innerHTML = `<input type="checkbox" id="forceImportChk" style="width:auto;"> Importar mesmo assim (não recomendado)`;
    body.appendChild(wrap);
    document.getElementById('forceImportChk').addEventListener('change', (e) => { confirmBtn.disabled = !e.target.checked; });
  }
  document.getElementById('previewOverlay').classList.add('show');
}
document.getElementById('previewCancelBtn').addEventListener('click', () => {
  document.getElementById('previewOverlay').classList.remove('show');
  pendingImport = null;
});
document.getElementById('previewConfirmBtn').addEventListener('click', async () => {
  if (!pendingImport) return;
  document.getElementById('previewOverlay').classList.remove('show');
  await commitFaturaImport(pendingImport);
  pendingImport = null;
});

async function commitFaturaImport(imp) {
  const faturaRecord = { vencimento: imp.vencimento, arquivo: imp.arquivo, rows: imp.rows, importedAt: Date.now() };
  faturasList = [...faturasList.filter((f) => f.vencimento !== imp.vencimento), faturaRecord];
  await storage.put('faturas', faturaRecord);

  const { updatedExpenses, confirmed } = autoConfirmParcelas(imp.rows, expenses);
  expenses = updatedExpenses;
  lastAutoConfirmedIds = new Set(confirmed.map((c) => c.after.id));
  if (confirmed.length) await storage.putMany('expenses', confirmed.map((c) => c.after));

  const predictions = buildFuturePredictions(allFaturaRows(), expenses, categories);
  if (predictions.length) {
    expenses = [...expenses, ...predictions];
    await storage.putMany('expenses', predictions);
  }

  await storage.setMeta('lastFaturaImportedAt', Date.now());
  currentVencimento = imp.vencimento;
  refreshFaturaSelect();
  document.getElementById('rcFaturaSelect').value = imp.vencimento;
  displayReconciliation(imp.vencimento);
  renderDescList(); render();
  const autoMsg = confirmed.length ? `, ${confirmed.length} parcela(s) conciliada(s) automaticamente` : '';
  setStatus(`${imp.rows.length} lançamentos da fatura importados${autoMsg}.`, 'rcStatusMsg');
}

function displayReconciliation(vencimento) {
  const { autoMatched, matched, faturaUnmatched, appUnmatched } = runReconciliation(vencimento, allFaturaRows(), expenses, lastAutoConfirmedIds);

  document.getElementById('rcSummary').classList.add('show');
  document.getElementById('rcAutoN').textContent = autoMatched.length;
  document.getElementById('rcOkN').textContent = matched.length;
  document.getElementById('rcFaturaN').textContent = faturaUnmatched.length;
  document.getElementById('rcAppN').textContent = appUnmatched.length;

  const rowHtml = (dataIso, desc, val, extra) => `
    <div class="rc-row">
      <span class="rc-date">${new Date(dataIso + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span>
      <span class="rc-desc">${escapeHtml(desc)}</span>
      <span class="rc-val">${fmtBRL(val)}</span>
      ${extra || ''}
    </div>`;

  let html = '';
  if (autoMatched.length) {
    html += `<div class="rc-group-title">🔵 Parcelas conciliadas automaticamente (${autoMatched.length})</div>`;
    html += autoMatched.map((m) => rowHtml(m.fatura.data, m.fatura.descricao, m.fatura.valor, '<span class="rc-auto-tag">automático</span>')).join('');
  }

  html += `<div class="rc-group-title">⚠️ Na fatura, não lançado no app (${faturaUnmatched.length})</div>`;
  html += faturaUnmatched.length ? faturaUnmatched.map((i) =>
    rowHtml(i.data, i.descricao, i.valor, `<button class="rc-add" data-desc="${escapeHtml(i.descricao)}" data-valor="${i.valor}" data-data="${i.tipo === 'parcelamento' ? vencimento : i.data}">+ lançar</button>`)
  ).join('') : `<div class="empty-state" style="padding:10px 0;">Nenhum — tudo que está na fatura já foi lançado.</div>`;

  html += `<div class="rc-group-title">⚠️ Lançado no app, não aparece na fatura (${appUnmatched.length})</div>`;
  html += appUnmatched.length ? appUnmatched.map((e) => rowHtml(e.data, e.descricao, e.valor)).join('')
    : `<div class="empty-state" style="padding:10px 0;">Nenhum — tudo que você lançou aparece na fatura.</div>`;

  html += `<div class="rc-group-title">✓ Conciliados manualmente (${matched.length})</div>`;
  html += matched.length ? matched.map((m) => rowHtml(m.fatura.data, m.fatura.descricao, m.fatura.valor)).join('')
    : `<div class="empty-state" style="padding:10px 0;">Nenhum lançamento conciliado manualmente ainda.</div>`;

  document.getElementById('rcLists').innerHTML = html;
  document.querySelectorAll('.rc-add').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelector('.tab-btn[data-tab="Lancamentos"]').click();
      cancelEdit();
      document.getElementById('desc').value = btn.dataset.desc;
      document.getElementById('valor').value = btn.dataset.valor;
      document.getElementById('data').value = btn.dataset.data;
      document.getElementById('desc').focus();
      vindoDaConciliacao = true;
    });
  });
}

/* ---------- Parcelas futuras ---------- */
function renderParcelas() {
  const groups = computeParcelaGroups(allFaturaRows());
  const forecastEl = document.getElementById('monthForecast');
  const listEl = document.getElementById('parcelasList');

  if (allFaturaRows().length === 0) {
    forecastEl.innerHTML = '';
    listEl.innerHTML = '<div class="empty-state">Importe uma fatura na aba Conciliação para ver as parcelas em aberto.</div>';
    return;
  }
  if (groups.length === 0) {
    forecastEl.innerHTML = '';
    listEl.innerHTML = '<div class="empty-state">Nenhuma parcela em aberto — nada previsto pra frente.</div>';
    return;
  }

  const byMonth = {};
  groups.forEach((g) => g.months.forEach((m) => { byMonth[m.ym] = (byMonth[m.ym] || 0) + m.valor; }));
  const yms = Object.keys(byMonth).sort();
  forecastEl.innerHTML = '<div class="rc-group-title" style="margin-top:0;">Previsão de parcelas por mês</div>' +
    yms.map((ym) => {
      const label = new Date(ym + '-01T00:00:00').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      return `<div class="mf-row"><span class="mf-month">${label}</span><span class="mf-val">${fmtBRL(byMonth[ym])}</span></div>`;
    }).join('');

  listEl.innerHTML = '<div class="rc-group-title">Parcelamentos em aberto</div>' + groups.map((g) => `
    <div class="parcela-card">
      <div class="pc-top"><span class="pc-desc">${escapeHtml(g.descricao)}</span><span class="pc-val">${fmtBRL(g.valor)}/mês</span></div>
      <div class="pc-meta">parcela ${g.parcela_atual} de ${g.parcela_total} · faltam ${g.remaining} · total restante ${fmtBRL(g.totalRestante)}</div>
      <div class="pc-months">próximas: ${g.months.map((m) => m.label).join(', ')}</div>
    </div>`).join('');
}

/* ---------- Service worker: registro + banner de atualização ---------- */
function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update(); });
    function showBanner(worker) {
      const banner = document.getElementById('updateBanner');
      banner.classList.add('show');
      document.getElementById('updateBtn').onclick = () => { worker.postMessage({ type: 'SKIP_WAITING' }); };
    }
    if (reg.waiting) showBanner(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showBanner(worker);
      });
    });
  }).catch(() => { /* offline no primeiro load, sem problema */ });
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

/* ---------- Boot ---------- */
document.getElementById('data').value = todayISO();
setupServiceWorker();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
loadAll().then(async () => {
  const migration = await storage.migrateFromLocalStorageIfPresent();
  if (migration.migrated) {
    await loadAll();
    setStatus(`${migration.expenses} lançamentos recuperados do app antigo (mesma origem).`);
  }
  document.getElementById('submitBtn').disabled = false;
  document.getElementById('submitBtn').textContent = 'Lançar gasto';
});
