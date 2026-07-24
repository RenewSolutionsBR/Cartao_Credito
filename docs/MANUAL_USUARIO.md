# Livro de Gastos — Manual do Usuário

Guia completo de uso do app, para quem só quer usar no dia a dia (não é um documento
técnico — para isso veja `DOCUMENTACAO_TECNICA.md`).

## 1. O que é o app

O Livro de Gastos é um app instalável no celular (PWA) que:
- Guarda seus lançamentos de gastos, com categorias, direto no aparelho (sem depender de
  internet no dia a dia).
- Lê sozinho o PDF da fatura do cartão (Santander Visa) e concilia automaticamente as
  parcelas que já estavam previstas.
- Exporta resumos e backups em Excel de verdade.

Os dados ficam **só no aparelho onde o app está instalado** — não há sincronização
automática entre celular e computador, nem entre Android e iPhone. Para levar os dados de
um aparelho para outro, use Backup completo → Importar backup (seção 8).

## 2. Instalar

### Android (Chrome)
1. Abra o link do app no Chrome.
2. Toque no menu (⋮, canto superior direito) → **"Adicionar à tela inicial"** ou
   **"Instalar app"**.
3. Confirme. Um ícone do Livro de Gastos aparece na tela inicial, abre em tela cheia,
   funciona offline.

### iPhone (Safari)
1. Abra o link do app no Safari (**precisa ser o Safari** — em outros navegadores do
   iPhone o botão de instalar não funciona igual).
2. Toque no ícone de compartilhar (o quadrado com uma seta pra cima ⬆️, na barra inferior).
3. Role a lista e toque em **"Adicionar à Tela de Início"**.
4. Confirme. O app aparece na tela inicial como qualquer outro.

Depois de instalado, sempre abra pelo ícone da tela inicial (não pelo navegador) — assim
ele roda em tela cheia e funciona melhor offline.

## 3. Aba Lançamentos

Tela principal, mostra os gastos do mês selecionado (setas `‹ ›` no topo trocam de mês).

### Lançar um gasto simples
Preencha Descrição, Valor, Data (formato `DD/MM/AAAA`, digite só os números que o app
formata sozinho) e Categoria, e toque em **"Lançar gasto"**.

### Lançar uma compra parcelada
Marque a caixa **"É uma compra parcelada?"**. O formulário muda para pedir o **valor
total** da compra e o **número de parcelas** — o app divide automaticamente (a última
parcela absorve a diferença de centavos, se houver) e lança uma parcela por mês, a partir
da data escolhida.

**⚠️ Leia a seção 9 antes de usar essa opção para uma compra que já apareceu na fatura do
cartão** — para esse caso específico, o botão "+ lançar" da aba Conciliação é o caminho
certo, não este checkbox.

### Editar ou excluir
Toque no ✎ (editar) ou ✕ (excluir) ao lado do lançamento. Ao editar a categoria de uma
parcela, **todas as outras parcelas da mesma compra são reclassificadas junto**
automaticamente (passadas, futuras e ainda previstas) — não precisa editar uma por uma.

### Exportar e backup
- **"Exportar resumo do mês (Excel)"**: gera uma planilha só com os lançamentos do mês em
  tela, mais um resumo por categoria.
- **"💾 Backup completo"**: gera um `.xlsx` com TODOS os lançamentos e categorias — é o
  arquivo que você deve guardar (Google Drive, e-mail para si mesmo, etc.) e também o que
  usa para levar os dados para outro aparelho.
- **"📥 Importar backup"**: lê um arquivo gerado pelo botão acima e adiciona os
  lançamentos que ainda não existem neste aparelho (não duplica os que já tinha).
- **"Apagar todos os dados do app"**: apaga tudo (lançamentos, categorias, faturas
  importadas) deste aparelho, sem volta — só use depois de ter certeza que fez backup.

## 4. Aba Conciliação

Aqui você importa a fatura do cartão e o app cruza automaticamente com o que você já
lançou.

### Importar a fatura
Toque em **"Fatura em PDF"** e escolha o arquivo do banco. O app lê o PDF sozinho
(offline) e mostra uma tela de conferência com todos os lançamentos reconhecidos e um selo
de **conferido** (a soma bate com o "Total a pagar" impresso na própria fatura) antes de
gravar qualquer coisa. Se não bater, revise antes de importar — pode ter faltado
reconhecer alguma linha.

Se preferir, também dá para importar uma planilha `.xlsx` da fatura (alternativa ao PDF).

### Os quatro grupos da conciliação
Depois de importar, a tela mostra o total da fatura selecionada e separa os lançamentos
em grupos:

- **🔵 Parcelas conciliadas automaticamente** — parcelas que já estavam previstas (ver
  aba Parcelas) e bateram sozinhas com a fatura, sem você precisar fazer nada. Isso inclui
  parcelas que a própria fatura já mostra como "N/M" com N maior que 1 mesmo sem você ter
  lançado antes — a numeração do banco já prova que a parcela 1 foi cobrada num período
  anterior.
- **✓ Conciliados manualmente** — lançamentos que você fez (gasto simples ou "+ lançar")
  e que bateram com uma linha da fatura.
- **⚠️ Na fatura, não lançado no app** — está na fatura mas ainda não tem lançamento
  correspondente. Toque em **"+ lançar"** para criar o lançamento com os dados já
  preenchidos (descrição, valor, data, e a identidade da parcela, se for o caso).
- **⚠️ Lançado no app, não aparece na fatura** — você lançou algo que não bateu com
  nenhuma linha desta fatura. Pode ser um gasto de outro meio de pagamento (não cartão),
  um erro de digitação, ou algo que ainda vai aparecer numa fatura futura.

### Exportar conciliação completa
O botão **"Exportar conciliação completa (Excel)"** gera uma planilha juntando, linha a
linha, o que está na fatura e o que está lançado no app, de todas as faturas já
importadas — útil para conferência ou para levar para outra ferramenta.

## 5. Aba Parcelas

Mostra, com base no que já foi importado das faturas, todas as parcelas em aberto: quanto
falta, em quantos meses, e o total por mês daqui para frente. Essas previsões
("parcela prevista") já aparecem também na aba Lançamentos, nos meses futuros, e são
substituídas automaticamente por um lançamento real assim que a fatura daquele mês chega.

## 6. Aba Dashboard

Visão geral dos seus gastos reais (não conta previsões de parcelas futuras, só o que já
foi de fato lançado):

- **Filtros de ano e mês** no topo — "Ano inteiro" ou um mês específico.
- **Total no período** e **variação vs. o período anterior** (mês anterior, ou ano
  anterior se o filtro for "Ano inteiro") — mostra se você gastou mais ou menos.
- **Gráfico de rosca por categoria** — para onde o dinheiro do período foi.
- **Gráfico de barras por mês** — os 12 meses do ano selecionado, para ver a tendência
  (a barra do mês filtrado, se houver, fica destacada).
- **Maiores gastos do período** — os 5 lançamentos de maior valor.

## 7. Categorias

Toque em **"gerenciar categorias"** (acima do campo Categoria, na aba Lançamentos) para
renomear, criar ou excluir categorias. A categoria **"A Classificar"** é usada
automaticamente pelo app quando uma parcela é confirmada pela fatura sem que você tenha
lançado nada antes daquela compra — é um sinal para você revisar e trocar pela categoria
de gasto de verdade (mercado, saúde, etc.) quando tiver um tempo.

## 8. Levar os dados para outro aparelho

1. No aparelho de origem: aba Lançamentos → **"💾 Backup completo"**.
2. Envie o arquivo `.xlsx` gerado para o outro aparelho (e-mail, WhatsApp, Drive...).
3. No aparelho de destino, já com o app instalado: aba Lançamentos →
   **"📥 Importar backup"** → escolha o arquivo.

Isso NÃO sincroniza automaticamente — é uma transferência manual, sempre que você quiser.

## 9. Recomendação importante: parcela nova que já apareceu na fatura

Quando a fatura mostra uma compra pela primeira vez como parcela **1/N**, existem dois
jeitos de lançar no app — mas eles não são equivalentes:

| Caminho | Quando usar |
|---|---|
| **"+ lançar"** na aba Conciliação, na linha da própria fatura | **Sempre que a compra já apareceu na fatura** (é o caso da imensa maioria dos parcelamentos no cartão) |
| Checkbox **"É uma compra parcelada?"** na aba Lançamentos | Só para compras que **ainda não apareceram em nenhuma fatura** — parcelamento fora do cartão, ou lançado por antecipação |

**Por quê:** o botão "+ lançar" usa a descrição exata que o banco imprimiu na fatura, o
que garante que as parcelas seguintes (2/N, 3/N...) sejam reconhecidas e conciliadas
sozinhas quando aparecerem nas próximas faturas, herdando a categoria que você escolher
agora. Se em vez disso você digitar a compra à mão no checkbox de parcelado, o app cria um
lançamento com um texto diferente do da fatura — as parcelas seguintes podem não se ligar
automaticamente à sua, e você corre o risco de ter dois lançamentos para a mesma compra
(um criado por você, outro pela conciliação automática da fatura).

**Se isso acontecer** (você lançar uma compra parcelada pelo checkbox e ela já estava — ou
vier a estar — na fatura): ao criar o lançamento parcelado, o app tenta perceber a
coincidência (mesma descrição parecida já aparecendo na fatura com parcela maior que 1) e
avisa antes de salvar, oferecendo apagar o que a fatura já tinha criado em favor do que
você está lançando agora. Ainda assim, esse aviso não cobre 100% dos casos (descrições
muito diferentes das da fatura podem passar despercebidas) — o caminho mais seguro
continua sendo usar sempre "+ lançar" para compras que já estão na fatura.

**Despesas avulsas (não parceladas) não têm esse problema**: um gasto simples lançado à
mão só cria UM registro, e a conciliação com a fatura é sempre recalculada na hora (não
duplica nada) — nesse caso, se o lançamento não bater com a fatura, ele aparece
corretamente em "Lançado no app, não aparece na fatura", sem gerar nenhum outro efeito
colateral.

## 10. Dúvidas comuns

**A fatura não bateu no checksum, o que eu faço?**
Revise a lista de lançamentos reconhecidos na tela de conferência. Normalmente é uma linha
que o parser não reconheceu (formato incomum). Você pode importar mesmo assim marcando
"Importar mesmo assim", e depois ajustar manualmente o que faltar — ou me avisar para eu
ajustar o parser.

**Apareceu "Atualização disponível" no rodapé, o que fazer?**
Toque em "Atualizar". O app recarrega com a versão mais nova. Seus dados não são afetados
(eles moram no IndexedDB do navegador, separado dos arquivos do app).

**Perdi o celular / troquei de aparelho, os dados foram junto?**
Não — os dados moram só no armazenamento local do aparelho. Por isso o backup periódico
(seção 8) é importante: é a única cópia de segurança fora do aparelho.

**Uma parcela ficou "presa" em "+ lançar" mesmo sendo N > 1?**
Não deveria mais acontecer (a numeração N/M da própria fatura já é suficiente para
conciliar sozinha) — se acontecer, é sinal de algum caso de borda não previsto; me avise
com o print da tela de Conciliação e o print da linha da fatura em PDF.
