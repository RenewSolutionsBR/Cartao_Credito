# Livro de Gastos — Documentação Técnica

Complementa o `README.md` (que cobre instalação/deploy) com o funcionamento interno do
app: modelo de dados, algoritmos de conciliação, parsing do PDF e limitações conhecidas.
Público-alvo: quem for dar manutenção no código (inclusive uma sessão futura de IA sem
memória desta).

## Stack

Vanilla JS (ES modules), sem build step, sem framework, sem dependências via CDN em
runtime — tudo vendorizado em `vendor/` para o service worker cachear com confiança e o
app funcionar 100% offline depois do primeiro load. As únicas bibliotecas de terceiros são
`xlsx.full.min.js` (leitura/escrita de `.xlsx`) e `pdf.min.mjs` + `pdf.worker.min.mjs`
(pdf.js, extração de texto do PDF da fatura).

## Estrutura de arquivos

```
index.html          shell do app, registra o service worker, define os elementos de UI
manifest.webmanifest
sw.js                cache offline versionado + fluxo de atualização
styles.css
src/
  app.js              UI, event handlers, orquestração — importa de storage.js/reconcile.js/pdf-parser.js
  storage.js           wrapper IndexedDB (get/put/remove/clear por store)
  pdf-parser.js         extração de texto do PDF + parsing de linhas + checksum
  reconcile.js           identidade de parcela, previsões, conciliação automática/manual
vendor/                xlsx.js e pdf.js vendorizados (mesma origem)
icons/
tools/
  test-parser.html      harness isolado pra testar o parser contra um PDF sem tocar nos dados do app
docs/
  MANUAL_USUARIO.md      guia end-user (Android/iPhone, todas as telas)
  DOCUMENTACAO_TECNICA.md este arquivo
```

## Modelo de dados (IndexedDB, `src/storage.js`)

4 object stores, sem biblioteca externa (wrapper próprio):

- **`expenses`** — chave primária `id`. Campos:
  - `descricao`, `valor`, `data` (ISO `YYYY-MM-DD`), `categoria` (id de uma categoria)
  - `previsto: true` — é uma projeção especulativa de parcela futura, não um gasto real
    ainda confirmado. Registros `previsto` **nunca** contam em totais de "gasto real"
    (Dashboard os exclui explicitamente).
  - `parcelaKey` — identidade estável da compra parcelada (ver seção seguinte), presente
    em qualquer registro (real ou previsto) que pertença a um parcelamento.
  - `parcela_atual` / `parcela_total` — número da parcela e total, quando aplicável.
  - `conciliadoAutomaticamente: true` — marcado quando o registro foi criado/confirmado
    por `autoConfirmParcelas` sem toque manual do usuário; persistido no próprio registro
    (não é um estado calculado por sessão) para sobreviver a troca de aba/fatura
    selecionada.
  - `origemManual: true` — marcado em previsões (`previsto: true`) criadas a partir do
    checkbox "compra parcelada" dos Lançamentos, e não de uma linha de fatura. Ver
    "Exceção à limpeza de previsões" abaixo.
  - `grupo_parcela` — id arbitrário ligando as N parcelas criadas numa mesma submissão do
    checkbox de parcelado (não usado para lógica de conciliação, só referência).
- **`categories`** — chave primária `id`. Campos `nome`, `cor`. Seed inicial em
  `DEFAULT_CATEGORIES` (`src/app.js`), incluindo a categoria de id fixo `a_classificar`
  (ver "Categoria 'A Classificar'" abaixo) — instalações antigas recebem essa categoria
  via migração no `loadAll()` se ainda não a tiverem.
- **`faturas`** — chave primária `vencimento` (upsert via `put`, uma fatura por
  vencimento). Campos: `dataCorte`, `arquivo`, `rows` (array de linhas parseadas),
  `importedAt`.
- **`meta`** — pares chave/valor livres (`lastBackupAt`, `lastFaturaImportedAt`).

## Parsing da fatura (`src/pdf-parser.js`)

`getTextContent()` do pdf.js não garante ordem de leitura em layouts de 2 colunas (a
fatura tem dois cartões — final 1519 e final 9168 — lado a lado). A extração:
1. Agrupa itens de texto por coluna (histograma de posição X, detecta o "vão" entre
   colunas dinamicamente, não um X fixo).
2. Dentro de cada coluna, agrupa por linha (tolerância de Y) e ordena por X.
3. `reconstructSegment` faz split recursivo de coluna com "completeness scoring" para
   lidar com layouts de 3 colunas ou ruído de cabeçalho/rodapé.
4. Bounds verticais entre os marcadores de texto "Detalhamento da Fatura" (topo) e "Juros
   e Custo Efetivo Total" (base), pra não capturar lixo fora da tabela de lançamentos.

Regras de linha: despesa = `data + descrição + valor`; parcelamento = idem + `NN/NN`
(parcela atual/total) antes do valor. `extractCutoffDate` lê a frase
"...compras...até DD/MM." da página 1 para achar `dataCorte`.

**Checksum obrigatório antes de importar**: soma das linhas parseadas por seção comparada
com o "VALOR TOTAL" impresso na própria fatura. Se não bater, a tela de preview bloqueia a
confirmação a menos que o usuário marque "Importar mesmo assim" explicitamente.

## Identidade de parcela (`computeParcelaKey`)

```js
computeParcelaKey(descricao, dataCompraOriginal, parcelaTotal)
  // => `${DESCRICAO_NORMALIZADA}|${dataCompraOriginal}|${parcelaTotal}`
```

`normalizeDescricao` só faz trim/uppercase/colapso de espaços — **não** faz fuzzy
matching. Duas linhas só têm a mesma `parcelaKey` se a descrição for exatamente igual
(após normalização), a data de compra original for igual, e o total de parcelas for
igual. Isso é o coração de toda a conciliação automática — e também sua principal
limitação (ver "Limitações conhecidas").

## Ciclo de vida de uma parcela

1. **Fatura documenta pela primeira vez** (`parcela_atual === 1`): não há como o app saber
   sozinho que é legítima — fica pendente em "Na fatura, não lançado no app", exige
   `+ lançar` manual. Esse botão carrega `data-parcelakey`/`data-parcela-atual`/
   `data-parcela-total` extraídos da própria linha da fatura, então o lançamento criado
   herda a identidade exata do banco.
2. **`syncPredictions`** roda depois de todo import de fatura: recalcula do zero (wipe +
   regenerate) todas as previsões (`previsto: true`) a partir de `computeParcelaGroups`
   (que olha só `allFaturaRows()`, o histórico de linhas de fatura já importadas — nunca os
   `expenses`). Isso é proposital: previsão é sempre derivada da fatura mais recente
   conhecida, nunca "acumula" — se o ritmo de cobrança mudou, a previsão antiga precisa
   sumir, não ganhar uma nova ao lado.
   - **Exceção à limpeza**: previsões com `origemManual: true` (nascidas do checkbox de
     parcelado manual, não de uma linha de fatura) são poupadas da limpeza, porque
     `computeParcelaGroups` não as conhece e nunca as regeneraria. Elas só saem de cena
     quando `autoConfirmParcelas` as substitui de verdade (ou o usuário as edita/apaga).
   - **Herança de categoria**: ao gerar uma previsão nova, `syncPredictions` procura entre
     `existingExpenses` um lançamento REAL (não previsto) com a mesma `parcelaKey` e usa a
     categoria dele; só cai na categoria `a_classificar` se não existir nenhum.
3. **Fatura seguinte documenta `parcela_atual > 1`**: `autoConfirmParcelas` procura entre
   as previsões (`previsto && parcelaKey === key`) a de data mais próxima do vencimento
   desta fatura e a promove a registro real, com um id **novo**, no namespace
   `confirmed_${key}_${vencimento}` (nunca reaproveita o id `seed_...` da previsão — ver
   "Por que o namespace de id importa" abaixo). Se não achar nenhuma previsão candidata
   (ex.: o vencimento "pulou" um mês), mas a própria fatura já numera a parcela como > 1,
   confirma mesmo assim — a numeração do banco já é prova suficiente de que a parcela 1
   foi cobrada antes. Nesse caso sem candidato, ainda tenta herdar a categoria de algum
   lançamento REAL existente com a mesma `parcelaKey` antes de cair em `a_classificar`.

### Por que o namespace de id importa

Uma previsão carrega no seu id (`seed_...`) o mês que ela mirava **no momento em que foi
gerada**. Se uma previsão fosse promovida a confirmada reaproveitando esse mesmo id, e
depois `syncPredictions` recalculasse as previsões (porque a fatura seguinte mudou o
ritmo, por exemplo) e gerasse uma previsão nova baseada num mês diferente mas que colidisse
no mesmo id — o passo de limpeza (`toRemoveIds`) apagaria a confirmação junto. Por isso
confirmações sempre ganham um id em namespace totalmente separado, e a previsão antiga é
removida explicitamente (`removedIds`) em vez de sobrescrita.

## Janela de conciliação (`getReconciliationWindow` / `getPoolWindow`)

Cada fatura tem uma janela de compras `[windowStart, windowEnd]` calculada a partir de
`dataCorte` (extraído do PDF) encadeada com a fatura anterior — sem sobra nem lacuna entre
faturas consecutivas. Sem `dataCorte` conhecido (fatura anterior desconhecida, ou
importada via planilha), cai numa estimativa de 35 dias.

O **pool** de candidatos para casar (`getPoolWindow`) é a janela oficial alargada em
`POOL_SLACK_DAYS = 3` para os dois lados — cobre casos em que o banco registra a data de
uma linha um pouco fora do período de corte "oficial" (particularidade observada nos PDFs
reais). A precisão de qual linha casa com qual continua vindo da identidade
(`parcelaKey`) ou da proximidade de poucos dias (despesa avulsa), então essa folga não
reintroduz ambiguidade entre faturas vizinhas — mas o balde "só no app" exibido na UI usa
a janela **oficial** (não a alargada), pra não mostrar como ruído algo que já pertence
legitimamente à fatura vizinha.

## Lançamento parcelado manual (`src/app.js`, checkbox "compra parcelada")

Só a parcela 1 vira um registro real; as parcelas 2..N entram como `previsto: true` +
`origemManual: true`, todas com a mesma `parcelaKey` calculada localmente
(`computeParcelaKey(descricaoDigitada, dataEscolhida, n)`). Ficam de fora do pool de
casamento da Conciliação (que filtra `!e.previsto`) até serem substituídas de verdade por
uma confirmação vinda de uma fatura real.

**Checagem de duplicidade** (`findParcelaDuplicates`): antes de criar os N registros,
verifica (a) se já existe algum `expense` com a mesma `parcelaKey` exata, e (b) uma
checagem mais fraca — linhas de fatura já importadas com descrição parecida (substring,
case-insensitive) e `parcela_atual > 1`, o que indica que a compra já vinha de antes. Se
achar algo, mostra um `confirm()` oferecendo apagar os registros existentes antes de
criar os novos. É uma heurística, não uma garantia — descrições muito diferentes da
digitada pelo banco não são pegas.

**Propagação de categoria** (`syncCategoriaAcrossParcelas`): toda vez que uma categoria é
definida/alterada num lançamento com `parcelaKey` (edição de um existente, ou criação de
um novo via `+ lançar` que carrega `pendingParcelaKey`), todos os outros registros
(reais e previstos) com a mesma `parcelaKey` são atualizados para a mesma categoria.

## Categoria "A Classificar"

Id fixo `a_classificar` (não depende do nome, ao contrário de versões anteriores do
código que buscavam por `nome.toLowerCase() === 'parcelamentos'` — trocado por busca por
id, mais robusto a rename do usuário). Usada como fallback final quando uma parcela é
confirmada automaticamente sem nenhum lançamento real anterior pra herdar categoria de —
sinaliza pro usuário que aquele gasto ainda não foi classificado por tipo.

## Dashboard (`src/app.js`, `renderDashboard`)

Sem biblioteca de gráficos — rosca via `conic-gradient` puro CSS (segmentos calculados em
JS como % acumulada, aplicados via `element.style.background`), barras via divs com altura
percentual. Só considera `expenses` com `!previsto` (gasto real, não projeção). Filtros de
ano/mês recalculam tudo a cada mudança; "variação vs. período anterior" compara com o mês
anterior (ou o ano anterior, se o filtro for "ano inteiro").

## Service worker (`sw.js`)

Cache versionado (`CACHE_VERSION`, bump manual a cada deploy) com estratégia
network-falling-back-to-cache dentro do mesmo `CACHE_VERSION`; `activate` limpa versões
antigas. Fluxo de atualização: novo SW instala e fica esperando; página detecta e mostra
banner "Atualização disponível"; ao tocar, `postMessage({type:'SKIP_WAITING'})` →
`skipWaiting()` → `controllerchange` → reload automático.

## Deploy

Ver `README.md` (`git push` + GitHub Pages, branch `main`, pasta raiz). Depois de todo
deploy, sempre bump do `CACHE_VERSION` em `sw.js` — sem isso, aparelhos já com o app
instalado continuam servindo os arquivos antigos do cache indefinidamente.

## Como validar mudanças na lógica de conciliação sem um navegador/Node disponível

Durante o desenvolvimento, mudanças em `reconcile.js` foram validadas espelhando a mesma
lógica em Python contra os PDFs reais das faturas (fora deste repositório, em scratch),
rodando a sequência completa de imports e checando os buckets resultantes contra os casos
relatados pelo usuário. Não é um substituto de teste real no app (não valida DOM,
storage.js, nem os handlers de UI) — só a lógica pura de `reconcile.js`. Sempre que
possível, valide também abrindo o app de verdade (`python -m http.server` na pasta do
projeto, ver `README.md`) antes de publicar.

## Limitações conhecidas

- **`parcelaKey` exige texto idêntico**: se o usuário digitar uma descrição diferente da
  impressa pelo banco (ex.: "Blessi" vs "BLESSI COMERCIO DE BRI") ao usar o checkbox de
  parcelado manual, a identidade não bate com a da fatura, e a cadeia de auto-conciliação
  das parcelas seguintes se rompe (cada uma vira um registro novo, categoria
  `a_classificar`, e a previsão manual original fica órfã — nunca confirmada nem limpa).
  Mitigado por `findParcelaDuplicates` (heurística, não garantia) — a recomendação de
  produto é usar sempre "+ lançar" pra compras que já estão na fatura (ver manual do
  usuário, seção 9).
- **Ordem de `storage.getAll`**: IndexedDB retorna por ordem de chave primária (`id`), não
  por ordem de inserção — código que dependa de ordem de criação de múltiplos registros no
  mesmo array (ex.: matching por valor sem usar `parcelaKey`) não pode assumir que o
  primeiro elemento do array é o mais antigo após um reload da página.
- **Checksum não cobre 100% dos casos**: garante que a SOMA bate, não que cada linha
  individual foi interpretada corretamente (duas trocas que se cancelam no total passam
  batido). A tela de preview existe justamente para checagem visual antes de gravar.
- **Sem sincronização entre aparelhos**: cada instalação é independente; a única ponte é
  o backup/restore manual em `.xlsx`.
