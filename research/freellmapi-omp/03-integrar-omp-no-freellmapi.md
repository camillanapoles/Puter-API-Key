# Integração: cadastrar o gateway FreeLLMAPI no oh-my-pi (`omp`)

Este é o "como fazer" derivado dos docs 01 e 02. O objetivo é um cadastro **assertivo**: previsível,
sem depender de descoberta em tempo de boot, sem metadados inventados e sem chaves em texto no
config versionado.

> Contexto útil: o FreeLLMAPI tem `npx freellmapi setup-pi`, `setup-dsh`, `setup-opencode`… mas
> **não** tem setup para `omp` (verificado por grep no repositório em 2026-10-16). O
> [`scripts/setup-omp-freellmapi.mjs`](../../scripts/setup-omp-freellmapi.mjs) deste repositório cobre
> essa lacuna já incorporando as pegadinhas abaixo.

---

## 1. As decisões, e por quê

| Decisão | Por quê |
| --- | --- |
| Provider em `~/.omp/agent/models.yml` com `api: openai-completions` e `baseUrl` `.../v1` | É o dialeto que o `omp` usa por padrão e o que o gateway serve melhor (tools, streaming, `max_completion_tokens`, `developer→system`). |
| **Lista explícita de `models:` em vez de `discovery:`** | Discovery derruba o provider quando o gateway está fora do ar no boot **[medido]** e funde ids com o catálogo embutido (o id `auto` herdou reasoning+visão) **[medido]**. |
| `reasoning: false` + `input: [text]` no `auto` | O `omp` não envia `reasoning_effort` nem finge visão para um roteador que pode servir qualquer modelo da cadeia. |
| `contextWindow` conservador (200 K) | O gateway já pula modelos que não cabem; declarar menos que o teto evita que o agente monte um prompt de 900 K e nenhum modelo da cadeia aceite. |
| `maxTokens: 32000` explícito | O `omp` envia esse número como `max_completion_tokens`; o gateway aceita o alias. Valor alto demais não ajuda (o router reserva no máximo 2 000 tokens na conta de cota, mas o provider limita o resto). |
| Chave via **nome de env var** (`FREELLMAPI_API_KEY`) | O `models.yml` fica sem segredo. ⚠ Se a variável não existir, o `omp` usa o texto literal como chave → 401 silencioso. O script escreve o `.env` (0600) para você. |
| `headers: User-Agent: pi-coding-agent` | O classificador do gateway reconhece `pi-coding-agent`, não `omp/x`. |
| `headers: X-FreeLLM-Task-Type: code` | Desloca os pesos do router para inteligência em vez de velocidade. |
| Perfis (`auto:coding`) usados **por role** | `--model freellmapi/auto:coding` não resolve (parser trata `:` como thinking level) **[medido]**; via `modelRoles` funciona **[medido]**. |

## 2. Passo a passo

```bash
# 0) O gateway precisa estar de pé (Docker, desktop app ou `npm run dev`).
curl -s http://127.0.0.1:3001/v1/models -H "Authorization: Bearer $FREELLMAPI_API_KEY" >/dev/null && echo gateway-ok

# 1) (opcional, recomendado) No dashboard do gateway: Fallback -> criar a cadeia "coding"
#    com 3-6 modelos que aceitam tools, em ordem, e DESLIGAR auto_include_new_models.

# 2) Cadastrar o provider no omp (script deste repo, com backup e --dry-run):
node scripts/setup-omp-freellmapi.mjs \
  --url http://127.0.0.1:3001 \
  --api-key freellmapi-xxxxxxxxxxxxxxxx \
  --chains coding,fast \
  --dry-run
#    ...e sem --dry-run quando o diff estiver bom.

# 3) Validar o que o omp resolveu
omp models freellmapi
#   freellmapi (4)
#   ┌───────────────────┬─────────┬─────────┬──────────┬────────┐
#   │ model             │ context │ max-out │ thinking │ images │
#   ├───────────────────┼─────────┼─────────┼──────────┼────────┤
#   │ auto              │    200K │     32K │ -        │ no     │
#   │ auto:coding       │    200K │     32K │ -        │ no     │
#   ...

# 4) Um turno real
omp -p --no-session --model freellmapi/auto "Reply with only OK"

# 5) Sessão de trabalho
cd ~/projetos/algum-repo && omp
```

## 3. Os arquivos gerados

O script escreve três coisas (tudo com backup + merge, nunca sobrescrevendo o que já existe):

1. **`~/.omp/agent/models.yml`** — o provider `freellmapi` com a lista de modelos. Se já houver um
   `providers:` no arquivo, apenas o bloco `freellmapi:` é substituído; outros providers ficam
   intactos. Versão comentada em [`configs/models.yml`](configs/models.yml).
2. **`~/.omp/agent/config.yml`** — merge do mapa `modelRoles` (`default`, `slow`, `plan`, `smol`,
   `tiny`, `commit`, `task`) e de `providers.maxInFlightRequests`. Versão comentada em
   [`configs/config.yml`](configs/config.yml).
3. **`~/.omp/agent/.env`** (0600) — `FREELLMAPI_API_KEY=…`, o arquivo que o `omp` lê sozinho.

## 4. Escolhendo o modelo: quatro padrões e quando usar cada um

| Padrão | Como usar | Quando |
| --- | --- | --- |
| **Roteador do gateway** | `--model freellmapi/auto` ou `modelRoles.default: freellmapi/auto` | Uso normal: o gateway escolhe o melhor modelo disponível e faz failover. É o que dá o "7,4 B tokens/mês". |
| **Cadeia nomeada** | `modelRoles.default: freellmapi/auto:coding` (declare o id no `models.yml`) — ou, por execução, `omp --model @default`/`@slow` | Você quer previsibilidade (só os modelos que você escolheu, na sua ordem) para código. |
| **Modelo real preso** | `--model freellmapi/claude-sonnet-4-5` | Comparar qualidade, reproduzir bug, validar uma tarefa crítica. Sem failover do gateway para outro provedor. |
| **Estratégia por request** | id `auto:smart`, `auto:fast`, `auto:reliable`, `auto:balanced` (declare e use por role) | Um role específico que deve priorizar inteligência (`slow`) ou velocidade (`smol`). |

## 5. Roles: o mapa recomendado

Vem de `configs/config.yml`; em resumo:

```
default : freellmapi/auto          # pool inteiro, cadeia ativa
slow    : freellmapi/auto:coding   # cadeia curada de código
plan    : freellmapi/auto:coding
smol    : freellmapi/auto:fast     # latência importa
tiny    : freellmapi/auto:fast
commit  : freellmapi/auto:fast
task    : freellmapi/auto
vision  : freellmapi/<id real com visão>
```

Detalhes que evitam surpresa:

- Role com `:` **só** funciona se o id estiver declarado no `models.yml` — ids com dois-pontos não
  passam pelo parser de seleção por CLI quando escritos literalmente. A saída é o **alias de role**:
  `omp -p --model @slow "…"` roda com o modelo do role `slow` (verificado: o corpo na rede leva
  `"model":"auto:coding"`), e `omp config get modelRoles` confirma o que está valendo.
- `cycleOrder` controla o `Ctrl+P`; deixe em `smol → default → slow` para alternar "rápido ↔ forte".
- Para trocar só na sessão corrente: `/switch` ou `Alt+P`; para trocar em uma execução: `--smol`,
  `--slow`, `--plan` (ou `PI_SMOL_MODEL`, `PI_SLOW_MODEL`, `PI_PLAN_MODEL` no ambiente).
- `--prewalk` + `smol` numa cadeia rápida = começa forte e barateia no primeiro edit.
- `--advisor` com `advisor: freellmapi/auto:coding` dá uma segunda opinião sem sair do gateway.

## 6. Concorrência (subagents) e limites

O `omp` abre subagents em worktrees isolados; cada um é um stream no gateway.

| Lado | Ajuste |
| --- | --- |
| omp | `providers.maxInFlightRequests: { freellmapi: 4 }` no `config.yml` (limita quantas requests simultâneas). |
| gateway | `PROXY_RATE_LIMIT_RPM=600` (padrão 120/min por IP pode ser atingido); `PROVIDER_STREAM_STALL_TIMEOUT_MS=180000`; `FALLBACK_TIME_BUDGET_MS=90000`. Arquivo pronto em [`configs/gateway.env.exemplo`](configs/gateway.env.exemplo). |
| cadeia | Subagents costumam pedir `smol`/`task`; aponte esses roles para a cadeia rápida para não queimar a cota boa com trabalho exploratório. |

## 7. Verificação (copie e cole)

```bash
# 1. o provider existe para o omp (mesmo com o gateway parado, com lista explícita)
omp models freellmapi

# 2. o gateway está servindo e o que está utilizável agora
curl -s "http://127.0.0.1:3001/v1/models?execution_status=ready" \
  -H "Authorization: Bearer $FREELLMAPI_API_KEY" | jq -r '.data[].id' | head -20

# 3. um turno direto pelo gateway, com a trilha de roteamento
curl -s -D- -o /dev/null http://127.0.0.1:3001/v1/chat/completions \
  -H "Authorization: Bearer $FREELLMAPI_API_KEY" -H 'Content-Type: application/json' \
  -H 'X-FreeLLM-Task-Type: code' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}],"stream":false}' \
  | grep -i 'x-routed-via\|x-fallback'

# 4. o agente de verdade, com tools e streaming
omp -p --no-session --model freellmapi/auto "Liste os arquivos deste diretório e diga quantos são"
```

O que se espera ver no dashboard *Recent calls*: o cliente classificado como **Pi** (por causa do
`User-Agent`), o modelo servido em `X-Routed-Via`, e — se houve troca — `X-Fallback-Trail`.

## 8. Troubleshooting

| Sintoma | Causa provável | Correção |
| --- | --- | --- |
| `Model "freellmapi/auto" not found` **e** `No models available. Set API keys…` no boot | provider via `discovery:` com o gateway fora do ar | use lista explícita (`configs/models.yml`) ou suba o gateway antes do `omp` |
| `Model "freellmapi/auto:coding" not found` | id com `:` não é selecionável por `--model` | use `modelRoles` (o id precisa estar no `models.yml`) |
| 401 do gateway | env var ausente ⇒ o `omp` mandou o **nome** como chave literal | exporte a variável ou escreva `~/.omp/agent/.env` (o script faz) |
| 429 com pouca carga | `PROXY_RATE_LIMIT_RPM` (120/min por IP) | `PROXY_RATE_LIMIT_RPM=600` |
| Resposta corta no meio, em streaming | watchdog de stream parado (90 s) | `PROVIDER_STREAM_STALL_TIMEOUT_MS=180000` |
| `error: context_length_exceeded` | prompt maior do que **qualquer** modelo restante da cadeia | baixe `contextWindow` no `models.yml` (ex. 128000) para o `omp` compactar antes |
| Latência de 30-40 s de vez em quando | failover dentro do gateway (primeiro candidato demorou) | olhe `X-Fallback-Detail=1`; considere cadeia curada (`auto:coding`) em vez do pool inteiro |
| Tool calls falhando de forma intermitente | modelo da cadeia rejeita `tools` (é "benched" 6 h após 3 rejeições) | curadoria da cadeia; opcionalmente `VALIDATE_TOOL_ARGUMENTS=1` no gateway |
| O agente insiste em visão/reasoning que não existe | id `auto` fundido com catálogo embutido | declare `reasoning: false`/`input: [text]` (ou `modelOverrides`) |
| Dashboard não mostra o agente | UA `omp/x` é desconhecido | `headers: User-Agent: pi-coding-agent` |
| `omp` não sobe: `/usr/bin/env: 'bun': No such file or directory` | pacote npm exige Bun | `npm i -g bun` ou use o instalador de `omp.sh` |

## 9. Segurança e escopo

- Não commite `models.yml`/`.env` com a chave; o script escreve a chave só no `.env` (0600).
- Alternativa sem chave no cliente: gere um **URL token** (`/v1/t/<token>`) e use
  `baseUrl: http://127.0.0.1:3001/v1/t/<token>` com `auth: none` — mas o token continua sendo um
  segredo (só revogável separadamente, o que ajuda em várias máquinas).
- O `omp` tem **approval mode `yolo` por padrão**: revise `tools.approvalMode`, use
  `--approval-mode=write|always-ask`, `--tools=…` ou hooks antes de soltar o agente em repositório
  compartilhado.
- O gateway é local-first, single-user. Não exponha na internet nem use em multiusuário.

## 10. Extensões possíveis

- **Variante com descoberta**: se o gateway estiver sempre de pé (serviço com restart), troque a lista
  explícita por `discovery: { type: openai-models-list }` + `modelOverrides` para o `auto`. Você ganha
  acompanhamento automático do catálogo e novos perfis sem editar o arquivo.
- **Dois providers do mesmo gateway** (`freellmapi` + `freellmapi-test`) para A/B de cadeias, como o
  `setup-pi` faz com `--profile`.
- **MCP do gateway**: ligue o MCP (`/mcp`) e registre no `omp` para o agente consultar saúde, uso e
  estratégia de roteamento em tempo real, ou chamar inferência por outra superfície.
- **`--mode rpc`/SDK**: orquestrar o `omp` de um script (CI, bot) mantendo exatamente este `models.yml`.
