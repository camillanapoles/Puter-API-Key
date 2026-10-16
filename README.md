# Puter API Key Studio

Create and manage unlimited random API keys (`sk-...`) using a website dashboard.

How it works:
- You sign in with Puter first.
- The backend verifies your Puter token using `https://api.puter.com/whoami`.
- You can generate, list, and revoke as many keys as you want.
- Keys are stored in `data/api-store.json`.
- API calls use the Puter token of the account that created the key.

## Two run modes (same page)

| Mode | Where | What works |
| --- | --- | --- |
| **Gateway** | `node server.js` (local or Render) | everything: sign-in, `sk-...` keys, account pool, OpenAI-compatible `/v1/*`, analytics |
| **Browser** | static host (GitHub Pages) | Puter sign-in + Playground calling `puter.ai.chat` directly. No `sk-...` keys (no backend) |

The page detects the mode at boot via `GET {gatewayBase}/health`. Without a gateway it
switches to browser mode and disables the `Keys`, `Accounts` and `Analytics` tabs with a
visible notice instead of failing silently.

The **Gateway URL** field (Playground tab) is the base for every call and accepts a
different origin, so the GitHub Pages site can talk to a gateway on Render. The session
token is stored per gateway (`puter_gateway_session_token:{url}`).

### Model aliases

`DEFAULT_CHAT_MODEL=fugu`. `POST /v1/chat/completions` also accepts the stable aliases
`fugu` and `claude-5.6`. Each alias resolves against the live Puter model list
(cached 10 min): exact id → alias candidates → ranked fuzzy matches →
`MODEL_ALIAS_FALLBACKS` → default. If Puter answers `invalid_model`, the next candidate
is tried automatically (streaming included). `GET /v1/models` lists the aliases too.

Configure with `FUGU_MODEL_CANDIDATES` / `CLAUDE_56_MODEL_CANDIDATES` to pin real ids.

### Deploy the gateway on Render

`render.yaml` is included: Render → **New +** → **Blueprint** → pick this repo → set
`PUTER_AUTH_TOKEN` (or sign in from the Auth tab after deploy). Then put the Render URL
in the page's **Gateway URL** field.

### Client render check

```bash
node server.js          # terminal 1
npm run probe:render    # terminal 2 -> expects RENDER-PROBE: PASS
```

The probe drives the served page with jsdom while blocking `js.puter.com`, asserting the
UI still renders, tabs stay clickable, and errors are reported on-page.

## 1) Install

```bash
npm install
```

## 2) Configure environment

Create `.env` from `.env.example`:

```env
PORT=3000
PUTER_API_ORIGIN=https://api.puter.com
SESSION_TTL_HOURS=24
```

Optional old fallback mode:

```env
PUTER_AUTH_TOKEN=...
APP_API_KEYS=sk_static_key
```

No-sign-in mode (recommended for local/single-user use):
- Set `PUTER_AUTH_TOKEN` in `.env`.
- The dashboard works without signing in.
- All generated keys use the server token, so they keep working even if you never sign in.

## 3) Run

```bash
npm run dev
```

Open:
- `http://localhost:3000`

## 4) Use the website

The dashboard is split into tabs: `Auth`, `Keys`, `Playground`, and `Templates`.

1. Click **Sign In With Puter**.
2. Create key(s) with random format like `sk-6fA2...`.
3. Copy a key and call:
   - `GET /v1/models`
   - `POST /v1/chat/completions`
   - `Authorization: Bearer <your-sk-key>`
4. Use **Terminal Template** section to copy ready-to-run Bash/PowerShell/CMD code.

## API Endpoints

- `POST /auth/puter/signin` - verify Puter token and create session
- `GET /auth/me` - current signed-in dashboard user
- `POST /auth/signout` - end dashboard session
- `GET /v1/keys` - list your keys
- `POST /v1/keys` - create a key
- `GET /v1/keys/:id/reveal` - reveal one key secret for copy
- `DELETE /v1/keys/:id` - revoke a key
- `GET /v1/models` - OpenAI-compatible model list for your API key
- `GET /v1/models/:model` - fetch one model by id
- `POST /v1/chat/completions` - call Puter model using API key
- `POST /v1/images/generations` - OpenAI-compatible image generation (also available at `/images/generations`)

## Example Request

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk_your_key_here" \
  -d "{\"model\":\"gpt-5-nano\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}"
```

## Example Image Request

```bash
curl -X POST http://localhost:3000/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk_your_key_here" \
  -d "{\"prompt\":\"A cinematic mountain landscape at sunrise\",\"size\":\"1024x1024\",\"response_format\":\"url\"}"
```

## Roo Code Setup (OpenAI Compatible)

In Roo Code, configure this server as an OpenAI-compatible provider:

1. Base URL: `http://localhost:3000/v1`
2. API Key: your generated `sk-...` key
3. Model: `gpt-5-nano` (or any id from `GET /v1/models`)

Compatibility notes:
- `POST /v1/chat/completions` now returns standard OpenAI-style JSON only (`choices[0].message.content`), with no custom `raw` field.
- `stream: true` is supported with SSE chunks and `[DONE]`, which Roo Code expects.

## Usar como provider de um coding agent

Qualquer cliente OpenAI-compatível funciona (base URL `{gateway}/v1`, chave `sk-...`). Se você quer
plugar isto num agente específico, o exercício equivalente foi feito para o **oh-my-pi (`omp`)** com
o gateway FreeLLMAPI: veja [`research/freellmapi-omp/`](research/freellmapi-omp/README.md)
(conexão, otimização, pegadinhas medidas) e o gerador
[`scripts/setup-omp-freellmapi.mjs`](scripts/setup-omp-freellmapi.mjs) (`npm run setup:omp`,
testes em `npm run test:setup-omp`).

## Notes

- Keys can be copied any time from the dashboard.
- New keys store both hash (for auth check) and secret value (for copy/reveal).
- Older keys created before this update may show `No Secret`; create a new key if needed.
- If Puter token changes/expires, sign in again in the dashboard.
- The server never exposes repo files: only `/`, `/index.html`, `/favicon.ico` and
  `/favicon_io/*` are served. `.env`, `server.js` and `data/api-store.json` return 404.
- See `CONTINUITY.md` for the agent hand-off checklist (state, checks, pending verification).
- `data/api-store.json` is git-ignored by default.
