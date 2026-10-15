# Continuidade entre sessões do agente

O agente morre a cada sessão; este arquivo existe para o próximo acordar sabendo
exatamente o que está feito, o que falta e como verificar sem perguntar nada.

## Arquitetura atual (2 modos, mesma página)

| Modo | Onde roda | O que funciona |
| --- | --- | --- |
| **Gateway** | `node server.js` (local ou Render) | tudo: login, chaves `sk-...`, pool de contas, `/v1/*` OpenAI-compatível, analytics |
| **Navegador** | site estático (GitHub Pages) | login Puter + Playground direto via `puter.ai.chat`. Sem chaves `sk-...` (não há backend) |

A página detecta o modo sozinha: faz `GET {gatewayBase}/health` no boot. Se não
houver gateway, entra em modo navegador e desabilita as abas `Keys`, `Accounts` e
`Analytics` (com aviso visível, sem erro silencioso).

O campo **Gateway URL** (aba Playground) define a base de todas as chamadas. Ele
aceita origem diferente, então a página no GitHub Pages consegue falar com um
gateway no Render. O token de sessão fica em `localStorage` por gateway
(`puter_gateway_session_token:{url}`), nunca misturado entre origens.

## Endereços

- Página pública (Pages): https://camillanapoles.github.io/Puter-API-Key/
- Gateway público alvo: https://puter-api-key.onrender.com (`render.yaml` já no repo)
- Gateway local desta sessão: `http://127.0.0.1:3000` (morre com o sandbox)

## Modelo: aliases estáveis

`DEFAULT_CHAT_MODEL=fugu`. Aliases aceitos em `POST /v1/chat/completions`:
`fugu` e `claude-5.6`. O servidor resolve o alias contra a lista real do Puter
(`getOpenAIModelList`, cache de 10 min) nesta ordem:

1. id exato, se existir na lista do Puter
2. candidatos do alias (`FUGU_MODEL_CANDIDATES`, `CLAUDE_56_MODEL_CANDIDATES`)
3. ids da lista que contenham a base do alias, ranqueados por `scoreModelCandidate`
4. `MODEL_ALIAS_FALLBACKS` (padrão: `claude-sonnet-4-5,gpt-5-nano`)
5. `DEFAULT_CHAT_MODEL`

Se o Puter responder `invalid_model`, o handler tenta o próximo candidato
(vale para streaming e não-streaming). `GET /v1/models` lista os aliases também.

⚠️ **Não confirmado:** os ids reais que o Puter serve hoje para "fugu"/"claude 5.6"
não puderam ser verificados neste sandbox (sem token Puter e sem acesso a
`api.puter.com`). Rode o check abaixo com uma conta conectada para confirmar e,
se precisar, fixe os ids em `FUGU_MODEL_CANDIDATES` / `CLAUDE_56_MODEL_CANDIDATES`.

## Checklist do próximo agente

```bash
npm install                 # package-lock aponta para registry.npmjs.org (já corrigido)
node --check server.js      # sintaxe
npm run probe:render        # requer servidor no ar; espera RENDER-PROBE: PASS
```

1. Suba o servidor: `node server.js` → `Gateway listening on 0.0.0.0:3000`
2. Confira o isolamento estático (todos devem ser 404):
   `curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/{.env,server.js,package.json,data/api-store.json}`
3. `curl -s http://127.0.0.1:3000/health` → `{"ok":true,"service":"puter-ai-key-gateway",...}`
4. Peça ao usuário para abrir a página e clicar **Sign In With Puter**.
   - No Pages: o token **não** volta para o agente. Não peça para colar no chat.
     O caminho é: usuário conecta → Playground funciona direto (modo navegador),
     ou usuário faz deploy do gateway no Render e informa a URL.
   - No gateway local/Render: `data/api-store.json` recebe a conta automaticamente.
5. Com conta conectada, valide os modelos reais:
   `curl -s -H "Authorization: Bearer sk-..." http://127.0.0.1:3000/v1/models | jq '.data[].id'`
   e depois um chat com `"model":"fugu"` e com `"model":"claude-5.6"`.
6. Registre aqui os ids reais que responderam e atualize os candidatos no `.env`/`render.yaml`.

## Segurança (não regredir)

- `express.static(".")` **foi removido**: expunha `.env`, `server.js`,
  `package.json` e `data/api-store.json` (que guarda tokens Puter). Hoje só
  `/`, `/index.html`, `/favicon.ico` e `/favicon_io/*` são servidos.
- O token Puter nunca é exibido na página nem enviado para lugar que não seja o
  gateway configurado pelo usuário.
- `data/api-store.json` e `.env` seguem no `.gitignore`.

## Estado desta entrega

- Renderização no cliente blindada: `defer` no CDN do Puter, `ensurePuter()` com
  timeout e mensagem tratada, banner `#renderStatus`, `data-client-rendered`,
  listener global de erro e `<noscript>`.
- Boot sem corrida: `accounts`/`analytics` só ligam depois do probe do gateway.
- `EventSource` com guarda (ambientes sem suporte não quebram a página).
- Sonda de render commitada em `scripts/render-probe.mjs` (`npm run probe:render`).
