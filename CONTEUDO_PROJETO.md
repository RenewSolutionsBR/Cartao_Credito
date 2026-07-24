# CONTEUDO_PROJETO.md — Memory Bank

## 1. OBJETIVO
PWA offline-first de controle de gastos pessoais que lê a fatura do cartão (Santander Visa) em PDF, concilia automaticamente com os lançamentos do usuário por identidade de parcela, e mantém dados só localmente (IndexedDB).

## 2. STACK
- Vanilla JS (ES modules), zero build step, zero framework.
- Vendorizado em `vendor/` (mesma origem, sem CDN runtime):
  - `xlsx.full.min.js` — SheetJS (leitura/escrita `.xlsx`).
  - `pdf.min.mjs` + `pdf.worker.min.mjs` — PDF.js (Mozilla, Apache 2.0), extração de texto do PDF.
- PWA: `manifest.webmanifest` + `sw.js` (cache versionado, precache-all, update-on-skipWaiting).
- Storage: IndexedDB via wrapper próprio (`src/storage.js`), sem lib externa.
- Deploy: GitHub Pages (branch `main`, root), repo `RenewSolutionsBR/Cartao_Credito`.
- Sem testes automatizados, sem Node/npm no projeto (dev feito com scripts Python paralelos em scratch, fora do repo, pra simular a lógica de `reconcile.js`).

## 3. ARQUITETURA E DIRETÓRIOS
```
index.html            shell PWA, todas as tabs/telas/modais (DOM estático, sem template engine)
manifest.webmanifest  ícones, start_url, display:standalone
sw.js                 CACHE_VERSION (bump manual TODO deploy!) + precache + update flow
styles.css            todo o CSS do app (tema "livro contábil": paper/ink/brass)
src/
  app.js               UI + event handlers + orquestração (arquivo maior, ~900 linhas)
  storage.js           IndexedDB: getAll/get/put/putMany/remove/clearStore/resetAllData/getByIndex/getMeta/setMeta/migrateFromLocalStorageIfPresent
  pdf-parser.js        parseFaturaPdf() — extrai texto (2 colunas), parseia linhas, checksum contra total impresso, extractCutoffDate
  reconcile.js         núcleo de negócio: identidade de parcela, previsões, conciliação (ver seção 4)
vendor/                libs de terceiros vendorizadas
icons/                 ícones PWA (192/512/512-maskable/apple-touch-180)
tools/test-parser.html harness isolado pra testar só o parser de PDF
docs/
  MANUAL_USUARIO.md          guia end-user completo (Android/iPhone, todas as telas)
  DOCUMENTACAO_TECNICA.md    arquitetura, algoritmos, limitações conhecidas (MAIS DETALHADO que este arquivo — ler antes de mexer em reconcile.js)
README.md              quickstart dev + deploy + install
```
**Módulos-chave de `reconcile.js`** (exports): `computeParcelaKey`, `computeParcelaGroups`, `syncPredictions`, `autoConfirmParcelas`, `getReconciliationWindow`, `runReconciliation`, `buildFullReconciliationRows`.

## 4. DECISÕES CRÍTICAS / WORKAROUNDS (não reverter sem reler `docs/DOCUMENTACAO_TECNICA.md`)
- **Identidade de parcela** = `computeParcelaKey(descricao, dataCompraOriginal, parcelaTotal)` — texto normalizado (trim/upper/colapsa espaço) + data + total. **Exige match exato de texto**, não fuzzy — é a causa raiz de várias limitações abaixo.
- **`previsto:true`** = projeção especulativa, nunca conta como gasto real (Dashboard, totais). `syncPredictions` faz **wipe-and-regenerate total** de todas as previsões a cada import de fatura (nunca acumula) — EXCETO registros com `origemManual:true` (nascidos do checkbox "compra parcelada" manual), que ficam de fora da limpeza porque `computeParcelaGroups` não os conhece.
- **Namespace de id separado**: confirmações usam `confirmed_${key}_${vencimento}`, previsões usam `seed_...` — NUNCA reaproveitar id de previsão numa confirmação (colisão silenciosa já causou bug real de confirmação sendo apagada por regeneração de previsão).
- **Auto-confirmação sem candidato**: linha de fatura com `parcela_atual > 1` confirma sozinha mesmo sem previsão correspondente (numeração do banco já prova que parcela 1 foi cobrada antes). Só `parcela_atual === 1` exige `+ lançar` manual.
- **Janela de conciliação**: por `dataCorte` (extraído do PDF, "compras até DD/MM"), encadeada entre faturas consecutivas — não usar heurística de dias fixos (±40d) do vencimento, já foi tentado e trocado por impreciso.
- **Pool de matching alargado** (`POOL_SLACK_DAYS=3`) vs. janela oficial mais estreita pro balde "só no app" — banco às vezes registra data de linha fora do corte oficial.
- **Categoria "A Classificar"** (id fixo `a_classificar`, buscar por id nunca por nome): fallback quando parcela confirma sem lançamento manual prévio pra herdar categoria. Categoria se propaga (`syncCategoriaAcrossParcelas`) pra todas as parcelas da mesma `parcelaKey` ao editar/criar qualquer uma.
- **Checkbox "compra parcelada" manual**: só parcela 1 vira registro real; 2..N viram `previsto+origemManual` (fora do pool de matching) — evita duplicar/competir com a conciliação automática da fatura.
- **`findParcelaDuplicates`**: aviso de possível duplicidade exige 3 condições juntas (descrição parecida E valor <R$0,05 de diferença E data <15 dias) — só descrição já causou falso positivo real (comerciantes recorrentes tipo "EVINO" com compras não relacionadas).
- **Checksum obrigatório** antes de gravar fatura importada (soma das linhas vs. "VALOR TOTAL" impresso) — bloqueia confirmação a menos que usuário force.
- **Dashboard**: gráficos em CSS puro (`conic-gradient` pra rosca, divs pra barras) — decisão deliberada de NÃO vendorizar Chart.js, mantém app leve/offline.
- **Datas sempre ISO internamente** (`YYYY-MM-DD`), formatação BR (`DD/MM/AAAA`) só na camada de UI (`formatDateBR`/`parseDateBR`).

## 5. ESTADO ATUAL
- **Entry point**: `index.html` → `<script type="module" src="src/app.js">` → boot no fim do arquivo (`loadAll()` + `setupServiceWorker()` + `navigator.storage.persist()`).
- **100% operacional e testado pelo usuário** (validado com faturas reais 30/01 a 30/06/2026):
  - Lançamentos: CRUD de gasto simples e parcelado, categorias, export mês, backup/restore `.xlsx`, reset de dados.
  - Conciliação: import PDF (com preview+checksum) ou `.xlsx`, 4 buckets (auto/manual/só-fatura/só-app), `+lançar`, export conciliação completa.
  - Parcelas: previsão de parcelas futuras por mês.
  - Dashboard: filtros ano/mês, total+variação, rosca por categoria, barras por mês, top-5 gastos.
  - Modal de aviso de duplicidade em lançamento parcelado manual (3 opções: apagar/manter/cancelar).
  - PWA instalada e funcionando em Android e iPhone do usuário.
- **Publicado**: `https://renewsolutionsbr.github.io/Cartao_Credito/` — `sw.js` atualmente em `livro-de-gastos-v13`.
- **NÃO testado por mim (Claude) em navegador real** — só validação de lógica pura (simulação Python) e leitura de código. Sempre pedir teste manual do usuário após mudança de UI/fluxo.

## 6. PENDÊNCIAS / AJUSTES FUTUROS
- `parcelaKey` por texto exato é frágil pra lançamento manual com descrição diferente da fatura — considerar normalização mais tolerante ou vincular por seleção explícita em vez de texto livre.
- Sem sincronização entre aparelhos — só backup/restore manual `.xlsx`; se usuário pedir sync automático, é mudança grande de arquitetura (hoje é 100% local).
- `findParcelaDuplicates` ainda é heurística (pode ter falso negativo com nomes/valores muito diferentes) — sem solução definitiva sem lançamento por referência direta à linha da fatura.
- Sem testes automatizados no repo — toda validação de `reconcile.js` foi manual/Python fora do repo; se for formalizar, considerar portar esses casos pra um test runner real.
- Dashboard: sem browser real testado por mim — checar responsividade/contraste em tela pequena e dark mode do SO, se relevante.
- `tools/test-parser.html` existe mas não foi atualizado desde a v1 do parser — conferir se ainda funciona antes de reusar.
