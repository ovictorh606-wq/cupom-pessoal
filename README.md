# Cupom Pessoal

Extensão de Chrome (Manifest V3) que testa cupons de desconto automaticamente
no carrinho, mais um scraper em Python que roda de graça no GitHub Actions
pra manter a lista de cupons atualizada. Feito pra uso pessoal — sem conta,
sem servidor pago, sem telemetria.

## Antes de começar — leia isto

Indo direto ao ponto, como eu revisaria isso numa reunião de time antes de
aprovar o sprint:

1. **O repositório vai ficar público.** GitHub Pages de graça (conta pessoal
   free) só funciona em repositório público — não existe "Pages privado" no
   plano gratuito. Ou seja: qualquer pessoa que souber a URL consegue ver o
   `cupons.json`. Isso não é um bug deste projeto, é uma limitação do GitHub.
   A privacidade real aqui é outra: **nada do que você navega ou compra é
   enviado a nenhum servidor de terceiros** — só isso e mais nada. Se algum
   dia você quiser o feed realmente privado, precisaria do GitHub Pro (Pages
   privado) ou hospedar o JSON em outro lugar.

2. **Raspar sites de comunidade (Pelando e afins) é o elo mais frágil.** Esses
   sites publicam conteúdo enviado por usuários, costumam ter proteção
   anti-bot, e os termos de uso deles geralmente restringem coleta
   automatizada em escala — rodar isso hora em hora tende a ser bloqueado
   rápido, e também é um uso que pode conflitar com os termos de uso do site.
   Por isso o `sources.json` vem com essas fontes **desabilitadas por
   padrão**. A abordagem mais sustentável é priorizar as **páginas oficiais
   de cupom das próprias lojas** (a maioria mantém uma, tipo
   `loja.com.br/cupons`, exatamente pra ser encontrada) como fonte principal,
   e tratar agregadores de comunidade como algo opcional — ou simplesmente
   deixar de fora e usar o campo de "cupons privados" da extensão pra colar
   códigos que você mesmo encontrar.

3. **Os seletores CSS em `sources.json` e em `content.js` são exemplos.** Eu
   não tenho como abrir o site de uma loja específica agora e confirmar as
   classes CSS atuais dela — e mesmo que tivesse, isso muda com o tempo, cada
   loja atualiza o front-end dela. Então: funciona como motor genérico e
   configurável, mas espera precisar ajustar seletor pra cada site que você
   for usar de verdade. A seção "Ajustando pra um site específico" mais
   abaixo mostra como.

4. **Detectar "qual botão aplica o cupom" e "quanto de desconto caiu" é
   heurística, não ciência exata.** `content.js` procura por textos comuns
   ("aplicar", "cupom aplicado", "cupom inválido") e por elementos de total
   com nomes de classe comuns. Funciona na maioria dos casos comuns, mas
   times de front-end de cada loja são livres pra escrever isso do jeito que
   quiserem — então trate como ponto de partida, não como garantia.

Nada disso é motivo pra não construir — é exatamente o tipo de ressalva que
você quer ter em mente *antes* de rodar isso contra uma loja de verdade, não
depois.

## Estrutura do projeto

```
cupom-pessoal/
├── README.md
├── scraper/
│   ├── scraper.py         # motor de scraping (Python + requests + BeautifulSoup)
│   ├── sources.json       # ONDE VOCÊ CONFIGURA as fontes (tudo desabilitado por padrão)
│   ├── requirements.txt
│   └── .state.json        # gerado automaticamente na 1ª execução (histórico interno)
├── .github/workflows/
│   └── update-coupons.yml # roda o scraper de hora em hora, de graça
├── docs/
│   └── cupons.json        # publicado pelo GitHub Pages (é o "CDN" gratuito)
└── extension/
    ├── manifest.json
    ├── background.js      # sincroniza o cupons.json em segundo plano
    ├── content.js          # testa os cupons na página de carrinho/checkout
    ├── popup.html / popup.css / popup.js
    └── icons/
```

## Passo a passo de instalação

### 1. Criar o repositório no GitHub

Crie um repositório novo **público** (precisa ser público pro GitHub Pages e
pros minutos do GitHub Actions saírem de graça — ver ressalva 1 acima). Suba
todos os arquivos deste projeto pra ele, mantendo a mesma estrutura de
pastas.

### 2. Ativar o GitHub Pages

No repositório: **Settings → Pages → Build and deployment → Source:
"Deploy from a branch"** → branch `main`, pasta **`/docs`** → Save.

Depois de alguns minutos, o GitHub mostra a URL do seu site, algo como:

```
https://SEU-USUARIO.github.io/SEU-REPOSITORIO/
```

O arquivo que a extensão vai consumir vai ficar em:

```
https://SEU-USUARIO.github.io/SEU-REPOSITORIO/cupons.json
```

Guarde essa URL — ela é usada no passo 6.

### 3. Configurar as fontes do scraper

Abra `scraper/sources.json`. Pra cada loja que você quiser acompanhar:

1. Abra a página de cupons da loja no navegador.
2. Clique com o botão direito num cupom listado → **Inspecionar**.
3. Identifique: qual elemento envolve cada cupom (`item_selector`), qual
   elemento tem o código (`code_selector`), qual tem a descrição
   (`desc_selector`, opcional) e qual tem a data (`date_selector`, opcional).
4. Copie o padrão de exemplo, ajuste os seletores, mude `"enabled": false`
   pra `"enabled": true`.

```json
{
  "name": "Minha Loja Favorita",
  "enabled": true,
  "type": "official_store",
  "url": "https://www.minhalojafavorita.com.br/cupons",
  "domain": "minhalojafavorita.com.br",
  "item_selector": ".oferta-card",
  "code_selector": ".oferta-codigo",
  "desc_selector": ".oferta-texto",
  "date_selector": "time"
}
```

Quer incluir um agregador de comunidade mesmo assim? É possível (`"type":
"community"`), só releia a ressalva 2 antes — considere rodar essa fonte
manualmente de vez em quando, em vez de deixar no cron de hora em hora.

### 4. Rodar o scraper pela primeira vez

Na aba **Actions** do repositório → workflow **"Atualizar cupons"** → **Run
workflow**. Depois de terminar, confira se `docs/cupons.json` foi atualizado
com os cupons de verdade (o workflow comita automaticamente quando há
mudança). A partir daí ele roda sozinho a cada hora — sem precisar disparar
manualmente de novo.

> Detalhe do GitHub, não deste projeto: workflows agendados (`schedule`)
> podem atrasar um pouco em horários de pico nos runners do GitHub, e o
> GitHub pausa automaticamente agendamentos de repositórios sem nenhum commit
> há 60 dias — nesses casos, um "Run workflow" manual religa tudo.

### 5. Carregar a extensão no Chrome

1. Acesse `chrome://extensions`.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** (Load unpacked).
4. Selecione a pasta `extension/`.

### 6. Configurar a extensão

Clique no ícone da extensão → cole a URL do `cupons.json` (do passo 2) no
campo **"URL do seu cupons.json"** → **Salvar**. O status no topo do popup
deve mudar pra mostrar quantos cupons foram sincronizados.

### 7. Testar

Adicione um produto ao carrinho em alguma loja configurada, abra a extensão
e clique em **"Testar cupons agora"**. Os resultados aparecem em tempo real,
e o cupom com maior desconto detectado fica aplicado no carrinho ao final.

## Ajustando pra um site específico

Se "Testar cupons agora" disser que não achou o campo de cupom, ou não
detectar o resultado, geralmente é questão de ajustar um seletor:

1. Inspecione o campo de cupom no site (botão direito → Inspecionar) e anote
   o `id`, `name` ou classe dele.
2. Adicione esse seletor no topo de `COUPON_INPUT_SELECTORS`, em
   `extension/content.js`.
3. Faça o mesmo pro botão de aplicar em `APPLY_TEXT_PATTERNS` (se o texto do
   botão for diferente de "aplicar"/"apply"/etc.) e pro elemento de total em
   `TOTAL_SELECTORS`.
4. Vá em `chrome://extensions` → **Recarregar** na extensão → teste de novo.

## Limitações conhecidas

- Checkouts que carregam o campo de cupom dentro de um `<iframe>` de
  pagamento (comum em alguns fluxos de cartão) podem não ser alcançados
  mesmo com `all_frames: true` no manifest, se o iframe for de um domínio de
  processadora de pagamento que bloqueia scripts externos.
- Sites que renderizam o carrinho inteiro via WebSocket/canvas (raro, mas
  existe) não expõem texto pro `MutationObserver` ler.
- O valor de desconto mostrado é uma **estimativa** (total antes vs. depois),
  não vem de nenhuma API oficial da loja.

## Uso responsável

Este projeto é pensado pra uso pessoal: testar cupons na sua própria compra,
não redistribuir os dados coletados nem rodar em escala comercial. Ajuste a
frequência e as fontes em `sources.json` com essa proporção em mente.
