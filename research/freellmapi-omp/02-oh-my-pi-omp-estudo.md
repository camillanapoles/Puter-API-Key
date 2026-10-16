# oh-my-pi (`omp`) — estudo investigativo

Fonte: [github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) + documentação oficial
(`omp.sh/docs/*`) + **instalação real** neste sandbox, `omp/18.11.1` (`npm i -g @oh-my-pi/pi-coding-agent`,
que exige **Bun** no PATH). Tudo marcado **[medido]** foi observado com o binário de verdade falando
com o gateway mock (`tools/mock-freellmapi.mjs`), com o corpo de cada request gravado em disco.

---

## 1. O que é

Agente de código **para terminal**, MIT, fork levado a sério do `pi-mono` (Mario Zechner) por Can
Bölük. Composição: TypeScript + um núcleo nativo em **Rust** (grep/glob via internals do ripgrep,
shell embutido herdando `brush-shell`, highlight, imagem, clipboard, ps/prof) e alguns utilitários em
Python. Vende-se como "batteries-included":

- **LSP in-process** (diagnostics, referências, rename com propagação) e **DAP** (lldb, dlv, debugpy)
  — o agente enxerga o que um editor enxerga;
- **Hashline edits**: edição ancorada por hash de linha em vez de `string→string`, eliminando o loop
  "string not found" e reduzindo muito o custo de tokens de saída em arquivos grandes;
- **Roles de modelo** (default/smol/slow/plan/vision/designer/commit/tiny/task/advisor) — roteamento
  por tipo de trabalho em vez de "um modelo para tudo";
- **Subagents** com isolamento de worktree (APFS/btrfs/overlayfs), plan mode, memória (Hindsight),
  sessions com resume/branch/fork/export, skills, extensions/hooks, MCP, e quatro modos de entrada:
  TUI, one-shot (`-p`), **NDJSON RPC** (`--mode rpc`) e **ACP** (Zed);
- **40+ providers** (API key, OAuth, assinatura, gateway, local) + qualquer endpoint
  OpenAI-compatible declarado à mão — é o gancho que usamos para plugar o FreeLLMAPI.

Herança de configuração: no primeiro run ele lê o que já existe em `.claude`, `.cursor`, `.windsurf`,
`.gemini`, `.codex`, `.cline`, `.github/copilot`, `.vscode` (rules, skills, MCP). Variáveis de
ambiente continuam aceitando o prefixo legado `PI_*` (e dentro de arquivos `.env`, uma chave `OMP_FOO`
é espelhada para `PI_FOO`).

## 2. Instalação

| Via | Comando |
| --- | --- |
| Instalador (binário pré-compilado) | `curl -fsSL https://omp.sh/install | sh` |
| Bun (**recomendado**) | `bun install -g @oh-my-pi/pi-coding-agent` |
| npm | `npm install -g @oh-my-pi/pi-coding-agent` — **precisa de Bun no PATH**, senão `omp` morre com `/usr/bin/env: 'bun': No such file or directory` **[medido]** |
| Homebrew | `brew install can1357/tap/omp` |
| mise (versão pinada) | `mise use -g github:can1357/oh-my-pi` |

Primeiro uso: `cd projeto && omp`, depois `/login` (OAuth de vários provedores) ou `/model` (colar
API key). Para providers que são só um endpoint, `/model` está fora do caminho: usa-se `models.yml`.

## 3. Camadas de configuração (a parte que decide a integração)

| Escopo | Arquivo | Serve para |
| --- | --- | --- |
| Global / perfil | `~/.omp/agent/config.yml` (perfil: `~/.omp/profiles/<nome>/agent/config.yml`) | roles, thinking, retry, compaction, providers habilitados, timeouts… |
| **Providers/modelos** | `~/.omp/agent/models.yml` (aceita `.yaml`; migra `models.json` legado) | **onde o gateway é cadastrado** |
| Projeto | `<cwd>/.omp/config.yml` (não procura em diretórios pais) | overrides do repositório |
| Overlay | `--config arquivo.yml` ou `PI_CONFIG_FILES` | CI/experimento, read-only |
| Runtime | flags (`--model`, `--slow`, `--thinking`, `--approval-mode`, …) e env | uma execução |

Precedência (menor→maior): defaults < global/perfil < projeto < overlays < flags. **Mapas fazem
merge profundo; escalares e arrays substituem** (um array no projeto troca o array global inteiro —
vale para `disabledProviders`, `enabledModels`, `cycleOrder`).

Env vars relevantes: `PI_CODING_AGENT_DIR` (relocaliza o diretório do perfil default — ótimo para
testar configuração sem sujar o real), `PI_CONFIG_DIR` (renomeia a raiz `.omp`), `OMP_PROFILE`,
`PI_SMOL_MODEL` / `PI_SLOW_MODEL` / `PI_PLAN_MODEL`. Ordem de leitura de `.env`: `$PWD/.env` →
`~/.omp/agent/.env` → `~/.omp/.env` → `~/.env`.

## 4. Registry de modelos — como um provider entra

Ordem de montagem no boot: catálogo embutido → **`models.yml`** → descoberta (cache/live) para
providers suportados e engines locais → providers registrados por extensions. Um modelo com mesmo
`provider`+`id` **substitui** a entrada embutida; descoberta pode atualizar e depois os overrides são
reaplicados.

`models.yml` (raiz única: `providers`):

```yaml
providers:
  freellmapi:
    baseUrl: http://127.0.0.1:3001/v1
    api: openai-completions        # ou openai-responses / anthropic-messages / google-generative-ai / …
    apiKey: FREELLMAPI_API_KEY     # nome de env var; se ela não existir, o texto vira a chave literal
    auth: apiKey | none | oauth
    headers: { ... }
    models: [ { id, name, reasoning, input, cost, contextWindow, maxTokens, supportsTools, … } ]
    modelOverrides: { <id>: { …patch de metadata… } }
    discovery: { type: openai-models-list | ollama | llama.cpp | lm-studio | litellm | proxy, timeoutMs }
    disableStrictTools: true       # proxies que rejeitam schema estrito
    compat: { … }                  # último recurso: ajustes de dialeto por endpoint
```

**Descoberta lê metadados reais** **[medido]**: com `discovery: {type: openai-models-list}` apontando
para um `/v1/models` que devolve `context_window` (o formato do FreeLLMAPI), o `omp` materializou
`contextWindow` idêntico ao anunciado (1 048 576 / 262 144 / 200 000 / 131 072), gravou o resultado em
`~/.omp/agent/models.db` (tabela `model_cache`, chave `freellmapi:openai-models-list-context-v4`) e
ainda **cruzou o id com o catálogo embutido**: `claude-sonnet-4-5` ganhou identidade anthropic +
tokenizer `claude-v3` + `maxTokens: 64000`; `gemini-3.6-flash`, identidade gemini; `deepseek-v4-flash`,
tokenizer `deepseek-v3`. Ids desconhecidos ficam com defaults genéricos.

Duas consequências práticas dessa "fusão por id":

1. **Pode inventar capacidade.** O id virtual `auto` do gateway recebeu `reasoning: true`,
   níveis de thinking e `input: [text, image]` — herança de outros fornecedores que usam `auto` como
   roteador inteligente. Resultado **[medido]**: o `omp` passou a mandar `reasoning_effort: "high"`
   (seu thinking default) e a marcar o modelo como aceita imagem, coisas que a cadeia `auto` do
   gateway não promete.
2. **Pode acertar muito.** Para ids reais (`claude-*`, `gemini-*`, `deepseek-*`) a metadata embutida é
   melhor do que a do gateway: tokenizer certo significa context meter e compaction mais precisos.

**Correção assertiva**: declarar a entrada explícita no `models.yml` (substitui a fundida para aquele
id) e/ou usar `modelOverrides` para ajustar um id descoberto.

## 5. Roles de modelo (roteamento interno do agente)

| Role | Trabalho |
| --- | --- |
| `default` | sessão interativa normal |
| `smol` | trabalho leve/rápido (também alvo do *prewalk*) |
| `slow` | raciocínio difícil e revisão |
| `plan` | plan mode (arquitetura) |
| `vision` | inspeção de imagem |
| `designer` | subagent designer |
| `commit` | mensagem de commit |
| `tiny` | classificações mínimas, títulos, memória, limpeza de fala |
| `task` | subagent genérico |
| `advisor` | modelo independente de revisão passiva |

Sintaxe do valor: `provider/model-id`, sufixo de thinking (`:off|minimal|low|medium|high|xhigh|max|auto`),
lista ordenada (`a/b,c/d` = primeiro disponível), alias de role (`@slow`, `*` = `@default`).
`modelRoles` mora no `config.yml`; `modelRoleStorage: project` permite gravar por projeto; `cycleOrder`
define o ciclo do `Ctrl+P` (padrão `smol → default → slow`). Flags `--smol/--slow/--plan` e
`PI_*_MODEL` sobrescrevem por execução.

## 6. Uma requisição real do `omp` **[medido]**

Pergunta trivial (`omp -p --no-session --model freellmapi/auto "Reply with only OK"`), capturada no
mock:

```http
POST /v1/chat/completions
authorization: Bearer <chave>
user-agent: omp/18.11.1                # ou o UA do provider, se você sobrescrever
accept: text/event-stream
```

```jsonc
{
  "model": "auto",
  "messages": [ {"role":"system","content":"…10 368 caracteres…"}, {"role":"user","content":"…"} ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "tools": [ /* 11 tools: read, bash, edit, eval, glob, grep, task, wait, todo, web_search, write */ ],
  "max_completion_tokens": 30000,
  "reasoning_effort": "high"
}
```

Observações que importam para qualquer gateway:

- **Não manda** `temperature`, `top_p`, `tool_choice` nem `parallel_tool_calls` por padrão.
- **Não usa `function.strict`** nos tools (nenhum dos 11 tinha `strict: true`) — logo, endpoints que
  rejeitam schema estrito não são problema.
- **`max_completion_tokens`** é o campo de saída (o gateway FreeLLMAPI aceita — ver doc 01 §5), e ele
  vem **do `maxTokens`** que o `omp` resolveu para o modelo **[medido]**: declarando `maxTokens: 32000`
  no `models.yml`, o corpo passou a levar `32000`.
- **`reasoning_effort`** só aparece se o modelo for marcado como `reasoning: true` **[medido]**;
  declarando `reasoning: false`, o campo desaparece.
- **System prompt grande** (~10 KB numa sessão limpa, sem rules/skills do projeto): não estranhe
  prompts de 15–40 KB por turno somando tools + arquivos lidos.
- **Tool loop completo funciona com streaming** **[medido]**: o mock devolveu `delta.tool_calls`, o
  `omp` executou `bash` de verdade e a segunda requisição veio com
  `roles: system,user,assistant(tool_calls),tool` — envelopes OpenAI limpos, `tool_call_id` preservado.
- **Headers do provider são aplicados em todo request** **[medido]**: com
  `headers: { User-Agent: pi-coding-agent, X-FreeLLM-Task-Type: code }` no `models.yml`, os dois
  chegaram no gateway.

## 7. Pegadinhas descobertas na prática (todas reproduzíveis)

1. **`discovery` cria dependência do gateway no boot** **[medido]**. Fiquei com o mock desligado:
   `omp models freellmapi` → `No models available. Set API keys in environment variables.` e
   `omp -p --model freellmapi/auto` → `Model "freellmapi/auto" not found`, *mesmo com o `models.yml`
   existindo*. Com `models:` explícito, a lista resolve normalmente e a falha é só na hora do request
   (timeout/ECONNREFUSED). Para "cadastrar assertivamente", lista explícita ganha.
2. **Ids com `:` não são selecionáveis por `--model` escrevendo o id** **[medido]**:
   `freellmapi/auto:coding`, `auto:coding`, `freellmapi/auto:coding:off` → `Model "…" not found`
   (o parser entende `:sufixo` como thinking level e não faz fallback para id literal).
   **Dois caminhos que funcionam**: (a) atribuir o id a um role — `modelRoles.default: freellmapi/auto:coding`
   enviou `"model":"auto:coding"` na rede; (b) usar o **alias de role** no CLI — `omp -p --model @slow …`
   também enviou `"model":"auto:coding"` **[medido]**. Nos dois casos o id precisa estar declarado no `models.yml`.
3. **Id nu é ambíguo**: `--model auto` sem provider resolveu para outra coisa e imprimiu lixo (um
   trecho numerado do próprio bundle) **[medido]**. Sempre use `provider/model-id`.
4. **npm global exige Bun** (§2).
5. **O UA `omp/<versão>` não é reconhecido por gateways que classificam cliente** (o FreeLLMAPI
   reconhece `pi-coding-agent`/`pi/<versão>`) — resolvível por `headers` do provider.
6. **Approval mode default é `yolo`** (as próprias docs avisam). Antes de apontar para um agente que
   edita e roda shell, decida a política: `/settings`, `--approval-mode=write|always-ask`, `--tools=…`,
   ou hooks bloqueando comandos perigosos.
7. **Tools anunciadas variam**: sessão limpa anunciou 11 tools; LSP, browser, github, image e debug
   aparecem conforme o backend/credencial estiver disponível. Um gateway só precisa saber que o
   conjunto é dinâmico e sempre vem em `tools[]`.

## 8. Recursos do `omp` que combinam com um gateway "de cota variável"

- **Compaction** (`compaction.enabled`, `thresholdPercent: 80`) + `contextPromotion` — como o
  `contextWindow` declarado manda no meter, declarar um número **honesto e conservador** para o
  roteador `auto` evita estourar modelos pequenos da cadeia.
- **Retry/fallback** próprios do agente (`retry` nas settings) para erros transitórios de rede, sem
  competir com o failover do gateway (que já é interno).
- **Subagents + worktrees** para paralelismo: aqui a concorrência bate no gateway — vale revisar
  `providers.maxInFlightRequests` (record por provider, ex. `{"freellmapi":4}`) e o
  `PROXY_RATE_LIMIT_RPM` do gateway.
- **Prewalk** (`--prewalk`): começa no modelo forte, troca para o `smol` no primeiro edit — combinação
  natural com cadeias `auto:coding` (forte) e `auto:fast` (barato) do gateway.
- **Advisor** (`--advisor`): revisão passiva por um segundo modelo — outro ponto onde apontar para um
  perfil diferente do gateway muda o eixo custo/qualidade sem tocar no código.
- **`--mode rpc` / SDK**: para orquestrar o `omp` de dentro de outro programa (CI, bots) mantendo o
  mesmo `models.yml`.
- **Sessions/resume/export**: histórico local, útil para auditar o que o gateway efetivamente serviu
  (`X-Routed-Via` no proxy do gateway, ou o log do próprio gateway).

## 9. Comparação rápida (por que ele, e não outro, para esse caso)

| Eixo | omp | Claude Code / Codex CLI | OpenCode / Cline |
| --- | --- | --- | --- |
| Provider customizado OpenAI-compatível | `models.yml` + `modelOverrides`, 40+ providers, roles | lock parcial ao vendor (Anthropic/OpenAI) | sim, mas sem roles nem LSP/DAP nativos |
| Edição | hashline (ancorada por hash) | string/diff | string/diff |
| Inteligência de código | LSP + DAP in-process | depende do editor | parcial |
| Multi-modelo por papel | roles nativos | não | limitado |
| Modos de execução | TUI, one-shot, RPC NDJSON, ACP, SDK | CLI/TUI | TUI/IDE |
| Custo de saída em arquivo grande | menor (hashline) | baseline | baseline |

## 10. Verificação rápida que você pode repetir

```bash
omp --version                     # omp/18.11.1 neste estudo
omp models freellmapi             # tabela: modelo, contexto, max-out, thinking, imagens
omp models find sonnet            # busca por id/nome
omp models refresh freellmapi     # força descoberta ao vivo
omp -p --no-session --model freellmapi/auto "Reply with only OK"
omp -p --no-session --model @slow "…"     # alias de role (caminho para ids com ':')
omp config get modelRoles         # confirma as atribuições efetivas
omp config list --json | jq '.providers'
```
