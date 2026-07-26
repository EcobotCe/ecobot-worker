# MIGRAÇÃO ECOBOT — de Railway/Express para Cloudflare Workers + GitHub Pages

## 1. O que mudou e por quê

**Causa raiz do erro do site:** em `index.html`/`ecobot.js`, a constante
`ECOBOT_BACKEND_URL` apontava para `https://ecobotce.github.io/site/` — ou
seja, o próprio GitHub Pages. GitHub Pages só serve arquivos estáticos, não
roda Express, então toda chamada a `/api/bases`, `/api/dados-recentes` etc.
falhava. Além disso o `Procfile` mandava rodar `bash start.sh`, arquivo que
não existe no projeto — o deploy no Railway também quebraria por causa disso.

**O que foi removido (não é mais necessário):**
- `server.js` (Express) — substituído pelo `worker.js`
- `check-alerts.js` — checagem de alertas + envio de e-mail (Nodemailer)
- `setup-db.js` e `migrate-preferences.js` — resíduos de uma versão antiga
  que usava PostgreSQL (`pg`), já não usado por `server.js`. Podiam ser
  apagados sem risco, mas provavelmente causavam confusão/erro no deploy.
- `Procfile`, `package.json`, `package-lock.json`, `.nvmrc`, `.idx/` —
  específicos do backend Node/Railway
- Rotas `/subscribe`, `/unsubscribe`, `/api/preferences` e toda a inscrição
  por e-mail no `index.html`
- `data/subscribers.json`, `data/alerts.json`, `data/base_states.json`,
  `data/subscriber_preferences.json` — só existiam para o fluxo de e-mail

**O que continua igual:**
- Sensores → Arduino/ESP → TagoIO: nada muda aqui.
- `data/bases.json` → agora vive dentro do Workers KV (mesmo formato).
- Frontend (`index.html`, `ecobot.css`, `favicon.ico`, `maintenance.html`) →
  continua 100% estático, hospedado no GitHub Pages.

**Novo backend:** um único arquivo `worker.js` rodando no **Cloudflare
Workers** (plano Free): 100.000 requisições/dia, sem cartão de crédito, sem
prazo de expiração e sem "dormir" (diferente de Render/Railway free tier).
Guarda a lista de bases no **Workers KV** (banco chave-valor incluso no
plano gratuito, até 1 GB e 1.000 escritas/dia — mais que suficiente pra
gerenciar algumas estações).

## 2. Passo a passo do deploy do Worker

Pré-requisito: Node.js instalado só para rodar o `wrangler` (a ferramenta de
deploy da Cloudflare) — o worker em si não roda Node, roda no edge da
Cloudflare.

```bash
# 1. Criar conta gratuita em https://dash.cloudflare.com/sign-up (não pede cartão)

# 2. Instalar o wrangler
npm install -g wrangler

# 3. Login
wrangler login

# 4. Dentro da pasta ecobot-worker/, criar o namespace KV
wrangler kv namespace create BASES_KV
# Isso imprime algo como:
#   { binding = "BASES_KV", id = "abcd1234..." }
# Copie o "id" e cole no wrangler.toml (linha "id = ...")

# 5. Popular o KV com as bases (ajuste seed-bases.json com os tokens reais
#    do TagoIO antes, se quiser subir os dados de produção)
wrangler kv key put "bases" --path=seed-bases.json --binding=BASES_KV --remote

# 6. Configurar a senha de administrador (a mesma usada para excluir bases)
wrangler secret put ADMIN_PASSWORD
# vai pedir pra digitar a senha (troque a antiga 'ecobot2026' por uma nova)

# 7. Deploy
wrangler deploy
```

Ao final, o Wrangler mostra a URL do worker, algo como:
```
https://ecobot-api.SEU-USUARIO.workers.dev
```

## 3. Conectar o frontend ao Worker

No `index.html` (já ajustado neste pacote), troque a linha:

```js
const ECOBOT_BACKEND_URL = 'https://ecobot-api.SEU-USUARIO.workers.dev';
```

pela URL real que o `wrangler deploy` te devolveu. Depois é só publicar o
`index.html`, `ecobot.css`, `favicon.ico` e `maintenance.html` no GitHub
Pages, do jeito que vocês já faziam.

> Dica: se quiser um domínio bonito em vez de `*.workers.dev`, dá pra
> conectar um domínio/subdomínio próprio ao Worker gratuitamente também
> (Cloudflare → Workers Routes), mas isso é opcional.

## 4. Adicionando as estações reais

Vocês tinham `TAGO_TOKEN_1` (base "EEEPDJWM") e `TAGO_TOKEN_2` (base
"EEEPDJWM 2.0") como variáveis de ambiente no Railway. Como agora as bases
ficam no KV, adicione-as de uma das duas formas:

**Opção A — pela própria interface admin do site** (mais simples): use o
formulário "Adicionar Base" que já existe no dashboard, com nome + token do
TagoIO de cada estação.

**Opção B — direto no KV**, editando `seed-bases.json` com os tokens reais
e rodando de novo o comando do passo 5 acima.

## 5. O que NÃO foi migrado (por ora, de propósito)

- **Alertas automáticos por e-mail**: removidos conforme pedido. Se no
  futuro vocês quiserem alertas sem e-mail (ex: só no histórico do próprio
  site), o Worker pode ganhar um **Cron Trigger** (também gratuito no plano
  Free) que roda `checkAlerts` periodicamente e grava em KV — é uma
  extensão pequena a partir do que já está aqui. Me avisem quando quiserem
  isso.
- **Histórico de alertas** (`/api/alerts`): o Worker responde `[]` por
  enquanto (pra não quebrar o botão "Exportar CSV" nem o painel
  "Histórico de Alertas"), já que não há mais nada gerando esse histórico
  sem o cron de e-mail.

## 6. Observação sobre `ecobot.js`

Esse arquivo parece ser uma cópia solta do JavaScript que já está embutido
dentro do `<script>` de `index.html` — ele não é carregado por nenhuma tag
`<script src="ecobot.js">` no HTML atual, então hoje ele não faz nada em
produção. Recomendo apagá-lo do repositório pra não gerar confusão (ou, se
a intenção é modularizar o código futuramente, ele precisa ser de fato
importado no `index.html`). Isso é só uma observação, não é obrigatório pra
essa migração.

## 7. Checklist final

- [ ] `wrangler deploy` feito, URL do worker copiada
- [ ] `ECOBOT_BACKEND_URL` atualizado no `index.html`
- [ ] Senha de admin nova configurada via `wrangler secret put ADMIN_PASSWORD`
- [ ] Bases reais (tokens do TagoIO) cadastradas via admin UI ou KV
- [ ] `index.html`, `ecobot.css`, `favicon.ico`, `maintenance.html` publicados no GitHub Pages
- [ ] Testar: abrir o site, checar se `/api/bases` e `/api/dados-recentes` respondem (aba Network do navegador)
