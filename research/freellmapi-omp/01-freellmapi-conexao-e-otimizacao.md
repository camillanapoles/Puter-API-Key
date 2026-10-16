# FreeLLMAPI — como a conexão funciona e como otimizar

Fonte: `github.com/tashfeenahmed/freellmapi` (branch `main`, clonado em 2026-10-16, 908 commits).
Referências de código são caminhos dentro do repositório (`server/src/...`), referências de doc são
`docs/en/...`.

---

## 1. O que o gateway é (e o que ele não é)

Um **proxy Express** que roda na sua máquina (porta padrão `3001`) e empilha os *free tiers* de ~34
provedores atrás de **um único endpoint OpenAI-compatível** e **uma única chave** (`freellmapi-…`):

- ~7,4 bilhões de tokens/mês somados, ~635 endpoints de modelo — mas **cota e disponibilidade são o
  teto**, não a classe do modelo (`docs/en/architecture/00-high-level-index.md`, seção *Limitations*).
- **Single-user por design**: sem multiusuário, sem billing. As chaves dos provedores ficam em SQLite
  cifradas com AES-256-GCM e são decifradas em memória por requisição.
- O router é um **bandit contextual** (Thompson sampling) que aprende com o tráfego: é um pool de
  fallback vivo, não um load balancer round-robin.

## 2. Superfícies de API expostas

| Superfície | Para quem |
| --- | --- |
| `POST /v1/chat/completions` | Todo cliente OpenAI (é a que o `omp` usa). |
| `POST /v1/responses` | Codex CLI e clientes Responses API. |
| `POST /v1/messages` | Claude Code / SDK Anthropic (mesmo router, wire Anthropic). |
| `POST /v1/completions` | Autocomplete legado (ghost-text de editores). |
| `POST /v1/embeddings`, `/v1/images/generations`, `/v1/videos/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions` | Mídia e embeddings. |
| `GET /v1/models` | Catálogo + descoberta (`?available=true`, `?execution_status=ready`). |
| `GET /v1beta/*` (Gemini) e `/api/*` (emulação Ollama) | Gemini CLI, Zed, JetBrains. |
| `POST /mcp` | MCP server (off por padrão em instalações novas; liga em *Keys → Agent compatibility*). |
| `GET|POST /v1/t/<token>/…` | Tokens de URL revogáveis para clientes que não enviam header. |
| `GET /v1/docs`, `/v1/openapi.json` | Visualizador OpenAPI sem dependências. |

**Base URL para clientes OpenAI-compatíveis é com `/v1`** (`http://localhost:3001/v1`); Claude Code
usa a raiz porque ele mesmo anexa `/v1/messages` (`docs/en/clients/02-supported-agents.md`).

## 3. Autenticação

1. Você cria a **chave unificada** no dashboard (página *Keys*) — formato `freellmapi-…`.
2. Todo request manda `Authorization: Bearer freellmapi-…`. `requireInferenceAuth` valida e o request
   entra no pipeline.
3. Credenciais dos provedores (as free tiers) são de uso interno do gateway. O cliente nunca as vê.
4. Para clientes que não conseguem mandar header, gere um **URL token** por agente
   (`/v1/t/<token>/chat/completions`) — revogável de imediato, com hash independente. A doc é
   explícita: *nunca* coloque a chave unificada na URL.

Chaves por provider podem ser **pools**: várias chaves grátis da mesma plataforma somam cota
(`usableKeyCount(platform)` multiplica o `monthly_token_budget` na conta de headroom) e a seleção
interna usa `auto`/`least-remaining`.

## 4. O caminho de uma requisição (o que realmente acontece)

```
cliente ──Bearer freellmapi-…──▶ /v1/chat/completions
   │ 1. auth + rate limit do proxy (PROXY_RATE_LIMIT_RPM, padrão 120/min por IP)
   │ 2. compressão (se ligada)        → reescreve o request antes de tudo
   │ 3. cache de resposta (se ligado) → match exato por hash do request completo
   │ 4. header X-FreeLLM-Task-Type    → enviesa os pesos do router (code|chat|auto)
   │ 5. escolha da cadeia             → perfil ativo, ou auto:<nome> pedido no campo model
   │ 6. router (bandit)               → score = f(confiabilidade, velocidade, inteligência)
   │                                   × headroom de cota × fator de rate-limit
   │ 7. ledger de rate limit          → RPM/RPD/TPM/TPD por (platform, model, key)
   │ 8. adapter do provider           → SDK, droplist de params, tradução de wire
   │ 9. failover loop                 → 429/5xx/timeout ⇒ cooldown + próximo candidato
   ▼
streaming SSE de volta ao cliente (ou JSON), headers X-Routed-Via / X-Fallback-*
```

Detalhes que importam para um agente de código:

- **Filtros de elegibilidade antes de tentar**: visão (imagem no request), **tools** (request com
  `tools` só vai para modelos `supports_tools`), **contexto** (modelos cujo `context_window` não
  cabe no prompt são pulados; `CONTEXT_WINDOW_SAFETY_FACTOR` + reserva de saída) — `server/src/services/router.ts`,
  `fitsContextWindow`, e `OUTPUT_RESERVE_CAP = 2000` (a saída reservada para roteamento é *capada*
  em 2 000 tokens para um `max_tokens` grande não excluir o pool inteiro — issue #470).
- **Failover com orçamento de tempo**: `FALLBACK_TIME_BUDGET_MS` (padrão 45 000 ms), ampliado
  adaptativamente pelo P95 de TTFB por endpoint (`SLOW_ENDPOINT_BUFFER_MS`, meia-vida de 2 dias).
  Em streaming o cronômetro é desarmado quando chega o primeiro byte.
- **Cooldowns e degradação graciosa**: quando o topo da cadeia esgota a cota diária, a resposta
  desce de nível (modelo menor) e volta a subir depois da meia-noite UTC.
- **Tool-call rescue**: modelos que devolvem tool call como texto são convertidos de volta em
  `tool_calls` (`server/src/lib/tool-call-rescue.ts`). Modelos que *rejeitam* requests com `tools`
  são "benched" por 6 h (3 rejeições em 1 h) e passam a ser tentados por último nesses requests
  (`server/src/lib/tool-capability.ts`).
- **Sticky session de 30 min**: a chave é o **hash da primeira mensagem `user`** (ou o header
  `X-Session-Id`, se presente). Isso mantém a mesma sessão no mesmo modelo — o que ajuda a reusar
  prefix cache do provider — e é o gancho do *context handoff* (uma mensagem `system` extra avisa o
  modelo novo que ele está assumindo uma conversa em andamento).
- **Headers de resposta**: `X-Routed-Via: platform/model`, `X-Fallback-Attempts`,
  `X-Fallback-Trail` (quem falhou e por quê), `X-Fallback-Detail` (opcional, com tempos por hop e
  mensagem do provider).

## 5. Camada de compatibilidade (por que "OpenAI-compatible" aqui é generoso)

O gateway normaliza o que os agentes costumam mandar de forma mais recente do que os free tiers
aceitam:

| O que o cliente manda | O que o gateway faz |
| --- | --- |
| `role: "developer"` | vira `system` no caminho OpenAI (`routes/proxy.ts`). |
| `max_completion_tokens` | aceito como alias de `max_tokens` (`routes/proxy.ts:1686`). |
| `reasoning_effort` fora da escala OpenAI **ou** desconhecido | normalizado: `xhigh/max/ultra → high`, `min→minimal`, `off → none`; valor que significa "deixa o modelo decidir" é **removido** em vez de causar 400 (`lib/sampling-params.ts`). |
| `stream_options.include_usage` | suportado nos adapters. |
| Params que um provider documentadamente rejeita | droplist por plataforma (`lib/sampling-params.ts`, política por plataforma) — e o modelo pode anunciar `supported_parameters`. |
| `tools` + `tool_choice` | repassado; tradução para `functionDeclarations` no Gemini; round-trip multi-step. |
| Contexto grande demais | o router evita modelos pequenos; se nada couber, erro `context_length_exceeded` com trilha. |

## 6. Otimização — 12 alavancas, com onde mexer

Ordenadas por impacto para um *coding agent* rodando em cima do gateway.

### 6.1 Curadoria da cadeia — a maior alavanca de previsibilidade
`Fallback` page → perfis nomeados. Antes de tudo: crie uma cadeia **"coding"** com os 3–6 modelos que
realmente funcionam bem com tools, ordem fixa, `auto_include_new_models = 0`, e passe a pedir
`model: "auto:coding"`. Sem isso, `auto` usa a cadeia ativa e a inteligência efetiva **cai ao longo
do dia** conforme as cotas diárias dos melhores modelos acabam (reset à meia-noite UTC).
`docs/en/fallback/01-named-chains.md`.

### 6.2 Estratégia de roteamento por tipo de request
`auto:smart` / `auto:fast` / `auto:reliable` / `auto:balanced` (sinônimos: `smartest`, `fastest`, …)
reordenam o pool inteiro ignorando a ordem da cadeia, **por request**. Complemento: header
`X-FreeLLM-Task-Type: code|chat|auto` desloca 30 % de um eixo de peso (ajustável em
`/api/settings/task-weight-share`) — para agente, `code` é o default correto (o gateway já infere
`code` quando vê `tools`, fence de código, stack trace ou `arquivo.ts:214`).

### 6.3 Rate limit do proxy quando há subagents
`PROXY_RATE_LIMIT_RPM` (padrão **120/min por IP**). Um `omp` com subagents paralelos e 11 tools por
turno chega fácil nisso, e o erro aparece como 429 *do gateway* (não do provider).
→ `PROXY_RATE_LIMIT_RPM=600` (ou `0` para desligar) em `.env`; `ADMIN_RATE_LIMIT_RPM` governa só o
dashboard.

### 6.4 Timeouts e orçamento de failover
- `PROVIDER_TIMEOUT_<PLATFORM>` (60 s na maioria; serve também de graça de **primeiro byte** em
  streaming).
- `PROVIDER_STREAM_STALL_TIMEOUT_MS` (padrão 90 000) — suba para 180 000–240 000 se streams cortarem
  no meio (free tiers enfileiram).
- `FALLBACK_TIME_BUDGET_MS` (45 000) — para turnos longos de agente, 90 000–120 000 reduz
  "attempts exhausted" em picos.
- `SLOW_ENDPOINT_BUFFER_MS` (10 000) e o P95 adaptativo trabalham a seu favor; não desligue.

### 6.5 Compressão de prompt (economia direta de cota)
`FREELLMAPI_COMPRESSION=off` por padrão. Para agente: `lossless` (dedupe de blocos repetidos,
higiene de espaços, JSON tabular reversível) é o ponto de partida seguro; `standard` acrescenta
filtros de saída de ferramenta (git/test/build/docker) com *fidelity gates* que preservam números,
hunks de diff, erros e envelopes de tool call. Por request: `X-FreeLLM-Compress: off|on|lossless|standard|aggressive`
— o header só **baixa** o modo, nunca sobe acima do global.

### 6.6 Cache de resposta (cota zero em repetição exata)
`RESPONSE_CACHE=false` por padrão. Cache **exato** (hash do request inteiro), TTL de 1 h, com
`X-FreeLLM-Cache: on|off` por request, `RESPONSE_CACHE_PERSIST` (⚠ grava respostas em texto no
SQLite) e gate de temperatura. Útil em retry/replay e prompts determinísticos; irrelevante para
turnos de agente que sempre carregam resultado de ferramenta novo.

### 6.7 Sticky session + prefix reuse
Não mexa na **primeira** mensagem `user` da sessão (é a chave do sticky). Sessão longa no mesmo
modelo ⇒ prefixo estável ⇒ cache do provider (DeepSeek/Anthropic/Gemini) com desconto real. Se o
cliente souber mandar `X-Session-Id`, mande: o sticky passa a ser explícito.

### 6.8 Context handoff
Quando há troca de modelo no meio da conversa, o gateway injeta uma mensagem `system` curta
explicando a troca (evita o modelo novo recomeçar a tarefa). Ative se você usa cadeias longas com
muita troca; desative se o agente é sensível a `system` extra.

### 6.9 Pools de chaves e headroom
Várias chaves grátis por plataforma somam orçamento. O `headroomFactor` (ramp em 20 % restante,
piso 10 %) rebaixa modelos perto do limite de cota — ajustável em
`routing_headroom_ramp_start` / `routing_headroom_floor`.

### 6.10 Segurança de exposição
Local-first: `HOST_BIND=127.0.0.1` no Docker (padrão), `HOST=::`/`0.0.0.0` só quando necessário;
`FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS=true` se o dashboard fica alcançável por terceiros. Tokens de
URL (`/v1/t/<token>`) para agentes; nunca a chave unificada em URL.

### 6.11 Observabilidade e manutenção
`X-Routed-Via` + `X-Fallback-Trail` (e `X-Fallback-Detail=1` para tempos) tornam cada request
auditável; o dashboard dá p50/p95/TTFT em janelas de 24 h–90 d; `keys test` revalida chaves;
backups do SQLite são cifrados; retenção de analytics/logs é configurável
(`REQUEST_ANALYTICS_RETENTION_DAYS`, `SERVER_LOGS_*`).

### 6.12 Catálogo e atualização
O catálogo assinado sincroniza 2×/dia de `freellmapi.co`: a instalação *free* acompanha o snapshot
mensal (cada modelo entra 30 dias depois de aparecer no feed ao vivo); a premium recebe no mesmo dia.
Modelos "quebrados" aparecem como 429/erro de auth até a correção do catálogo chegar — o teste real
que resolve isso é `GET /v1/models?execution_status=ready` antes de culpar seu cliente.

## 7. Implantação (resumo)

- **One-liner (Docker)**: `curl -fsSL https://freellmapi.co/install.sh | bash` cria `~/freellmapi`,
  gera `ENCRYPTION_KEY`, puxa a imagem e sobe o container. Reexecutar é seguro.
- **Desktop app**: `.dmg`/`.exe` nos Releases — roteador + dashboard na bandeja do sistema, sem
  conta/senha, credencial = chave unificada do popover.
- **Docker Compose / dev local**: `docker-compose.yml` e `npm run dev` no monorepo.
- **Primeiro acesso**: a primeira conta é criada pelo dashboard; se o servidor é alcançável por
  outras máquinas, exige um **código de uso único** impresso no log (impede que um estranho reivindique
  a instalação).
- **Produção**: PM2/systemd; ~40 MB RSS em idle; roda em ARM (Raspberry Pi) com Node 20+.

## 8. Limites que você deve assumir

- Sem SLA: cota e disponibilidade dos free tiers mudam sem aviso.
- Latência muito variável (Cerebras/Groq rápidos, outros não) e **inteligência efetiva degrada** no
  fim do dia.
- Não suportado hoje: `/v1/moderations`, `n > 1`, multiusuário/billing.
- Uso pessoal, revisado contra os ToS de cada free tier (tabela no repositório) — mantenha local.
