# Livro de Gastos

App de controle de gastos e conciliação de fatura de cartão (Santander Visa), como PWA
instalável no celular. Sucessor do `gastos-app.html` que rodava como artefato no chat do
Claude — agora roda sozinho, com dados salvos localmente (IndexedDB) e leitura automática
do PDF da fatura, sem depender de IA nem de internet no dia a dia.

## O que mudou em relação ao `gastos-app.html`

- **Instalável**: PWA de verdade (ícone na tela inicial, abre em tela cheia, funciona offline).
- **Dados persistentes**: IndexedDB em vez de localStorage/artefato de chat — não se perdem
  quando o app é fechado, nem dependem de eu gerar uma nova versão do HTML a cada fatura.
- **Fatura em PDF é lida pelo próprio app**: nada de colar o PDF no chat — o app extrai o
  texto do PDF (pdf.js) e interpreta os lançamentos sozinho, com uma tela de conferência
  (checksum contra o total declarado na fatura) antes de gravar qualquer coisa.
- **Export em Excel de verdade**: o botão de exportar/backup gera `.xlsx` de fato (a
  limitação de só sair `.txt` era do sandbox do artefato de chat, não do formato do app).
- **Conciliação automática de parcelas**: uma parcela que já estava prevista aqui bate
  sozinha com a linha correspondente da fatura (por identidade da compra, não só pelo
  valor — cobre pequenas diferenças de centavos entre faturas), sem precisar tocar em
  "+ lançar". Só pede confirmação manual pra lançamentos realmente novos.

## Estrutura

```
index.html          shell do app, registra o service worker
manifest.webmanifest
sw.js                cache offline + fluxo de atualização
styles.css
src/
  app.js              UI e regras de negócio
  storage.js           camada IndexedDB (expenses, categories, faturas, meta)
  pdf-parser.js         leitura do PDF da fatura (pdf.js) + checksum
  reconcile.js           conciliação e confirmação automática de parcelas
vendor/                xlsx.js e pdf.js vendorizados (mesma origem, cacheáveis offline)
icons/
tools/
  test-parser.html      página isolada pra testar o parser contra um PDF sem abrir o app
```

## Testar localmente antes de publicar

Não abra `index.html` direto como arquivo (`file://`) — service worker e alguns recursos
de PWA exigem `http(s)://`. Sirva a pasta com qualquer servidor estático simples, por
exemplo (na pasta `gastos-app`):

```
python -m http.server 8080
```

e acesse `http://localhost:8080` no navegador do computador (ou do celular, se estiver na
mesma rede Wi-Fi, trocando `localhost` pelo IP do computador). Teste:
1. Lançar/editar/excluir um gasto, incluindo um parcelado.
2. Importar uma fatura em PDF na aba Conciliação e conferir a tela de checksum.
3. Exportar o resumo do mês e o backup completo.
4. Recarregar a página em modo avião — o app deve continuar funcionando.

Também dá pra abrir `tools/test-parser.html` isoladamente (mesmo servidor) pra testar só o
parser contra um PDF, sem mexer nos dados salvos do app.

## Publicar no GitHub Pages

1. Crie um repositório novo no GitHub (pode ser privado, se preferir — GitHub Pages
   funciona em repositório privado nos planos pagos; em conta gratuita, Pages exige
   repositório público).
2. Dentro da pasta `gastos-app`:
   ```
   git init
   git add .
   git commit -m "Livro de Gastos: PWA inicial"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git
   git push -u origin main
   ```
3. No GitHub: **Settings → Pages** → em "Build and deployment", escolha **Deploy from a
   branch**, branch `main`, pasta `/ (root)`. Salve.
4. Em alguns minutos o app fica em `https://SEU_USUARIO.github.io/SEU_REPOSITORIO/`.
   Os caminhos do `manifest.webmanifest` são relativos, então funciona nesse subcaminho
   sem precisar editar nada.

## Instalar no celular

- **Android (Chrome)**: abra o link, toque no menu (⋮) → "Adicionar à tela inicial" /
  "Instalar app".
- **iPhone (Safari)**: abra o link, toque no ícone de compartilhar (□↑) → "Adicionar à
  Tela de Início". O Safari não mostra um botão de instalação automático como o Android —
  esse é o único caminho.

## Migrar os dados do `gastos-app.html` antigo

No app antigo, toque em "💾 Backup completo" pra gerar o `.xlsx`. No app novo (já
instalado), aba Lançamentos → "📥 Importar backup" → escolha esse arquivo. Pode repetir
sempre que quiser levar dados de um dispositivo pro outro, já que não há sincronização
automática entre aparelhos — cada instalação guarda seus dados localmente.

## Backup

Os dados moram só no seu celular (IndexedDB). Para não depender só disso, faça
"💾 Backup completo" periodicamente — o app mostra há quantos dias você não faz um. Em
iPhone especialmente, o sistema pode (raramente) limpar dados de um app instalado que
fique muito tempo sem ser aberto; o backup é a rede de segurança real.

## Atualizações

Quando eu publicar uma nova versão dos arquivos (novo `git push`), o app detecta sozinho
na próxima vez que for aberto ou voltar ao primeiro plano, e mostra um aviso "Atualização
disponível" na parte de baixo da tela — toque em "Atualizar" pra aplicar.
