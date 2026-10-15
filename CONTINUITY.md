# CONTINUITY — leia isto primeiro (o agente morre a cada sessão; este arquivo não)

## Goal
Usar LLM do Puter **gratuitamente** (modelo **fugu** ou **Claude mais novo / "5.6"**)
via gateway OpenAI-compatible deste repo, sem re-login a cada sessão.

## Fluxo de captura do token (1 vez só)
1. Suba o servidor (abaixo) e abra a página hospedada (preview).
2. Usuário clica **Sign In With Puter** na página.
3. A página pega o token da sessão Puter (`puter.authToken`) e faz automaticamente:
   - `POST /auth/puter/signin` → sessão do dashboard (`localStorage: puter_gateway_session_token`)
   - `POST /v1/accounts` → **token Puter salvo no servidor** em `data/api-store.json`
     (variável local persistente entre sessões; arquivo git-ignored, nunca commitar)
4. Na aba **Keys**, criar uma chave `sk-...` (também salva em `data/api-store.json`).
Pronto: sessões futuras NÃO precisam de login enquanto o token Puter for válido.
Se der 401 `provider_auth_error`, o token expirou → repetir passo 2 (30 segundos).

## Retomar em nova sessão (otimizado: 2 comandos)
```bash
npm install   # só se node_modules sumiu
npm run resume  # diagnóstico mascarado: contas, keys, servidor, próximo passo
npm start       # se o servidor estiver DOWN (porta 3000, bind 0.0.0.0 pelo Express)
```

## Modelos (aliases estáveis — nunca confie em id fixo)
- `model: "fugu"` ou `"claude-5.6"` no `POST /v1/chat/completions`.
- O servidor resolve o alias em tempo real via `puter.ai.listModels()` (cache 10 min):
  fugu → id real contendo "fugu" (ultra primeiro); claude-5.6 → Claude de maior versão.
- Se o modelo preferido retornar `invalid_model`, cai automaticamente na cadeia:
  melhor Claude descoberto → `claude-sonnet-4.5`-style → `gpt-5-nano`.
- `DEFAULT_CHAT_MODEL=fugu` no `.env`. `GET /v1/models` também lista os aliases.

## Teste rápido (após resume indicar key)
```bash
curl -s http://localhost:3000/v1/chat/completions -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk_SUA_KEY" \
  -d '{"model":"fugu","messages":[{"role":"user","content":"diga ok"}]}'
# streaming (stream:true) também suporta a cadeia de fallback antes do 1º chunk.
```

## Estado atual
- Servidor: Express em `server.js` (porta `PORT`, default 3000).
- Persistência: `data/api-store.json` = { users, keys, accounts[] com token Puter }.
- Fallback multi-conta já existia: falha numa conta → tenta a próxima (cooldown 60s).
- NUNCA imprimir/commitar token ou `sk-` completa; usar máscara `xxxx****yyyy`.

## Checklist do próximo agente
1. `npm run resume` → 2. servidor DOWN? `npm start` → 3. sem conta? pedir login na página
→ 4. sem key? pedir criação na aba Keys → 5. testar chat com `fugu` → 6. relatar `model` retornado (id real usado).

## Renderização cliente (garantia)
- `index.html`: script do Puter com `defer` (não bloqueia o 1º paint), `ensurePuter()` antes de
  qualquer `puter.*`, banner `#renderStatus` + `documentElement.dataset.clientRendered="true"`
  ao fim da init, `<noscript>` e listener de erro que mostra falha na página (nunca tela branca silenciosa).
- Prova: `npm i -D jsdom && npm run probe:render` -> espera `RENDER-PROBE: PASS`
  (renderiza e troca de aba até com js.puter.com inacessível).
