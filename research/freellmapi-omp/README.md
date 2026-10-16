# FreeLLMAPI × oh-my-pi (omp) — investigação e integração

Estudo em duas partes, feito em 2026-10-16:

1. **Como o [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) conecta e como otimizá-lo** (gateway
   pessoal que empilha ~34 free tiers atrás de um único endpoint OpenAI-compatível).
2. **Como o coding agent [oh-my-pi / `omp`](https://github.com/can1357/oh-my-pi) carrega providers** e
   **qual é a forma mais assertiva de cadastrar o gateway FreeLLMAPI nele**.

Tudo o que está aqui foi verificado de duas formas: leitura do código-fonte dos dois projetos
(commit `main` do freellmapi baixado no dia, `omp/18.11.1` instalado via npm) e **teste real** com o
`omp` de verdade apontado para um gateway mock que replica o formato das respostas reais do
FreeLLMAPI (`tools/mock-freellmapi.mjs`). Os achados experimentais estão em `tools/evidence.json`
e cada um tem o comando que o reproduz.

## Índice

| Arquivo | Conteúdo |
| --- | --- |
| [`01-freellmapi-conexao-e-otimizacao.md`](01-freellmapi-conexao-e-otimizacao.md) | Anatomia da conexão (auth, superfícies de API, router/bandit, failover, rate limits, camada de compatibilidade) e 12 alavancas de otimização com onde/porquê. |
| [`02-oh-my-pi-omp-estudo.md`](02-oh-my-pi-omp-estudo.md) | Estudo do `omp`: arquitetura, instalação, camadas de configuração, registry de modelos, roles, fluxo de uma requisição real (medido), recursos que importam para gateway e as pegadinhas descobertas na prática. |
| [`03-integrar-omp-no-freellmapi.md`](03-integrar-omp-no-freellmapi.md) | **A receita definitiva**: `models.yml` + `config.yml` recomendados, script gerador, validação, uso de perfis `auto:<chain>`, concorrência com subagents e tabela de troubleshooting. |
| [`configs/`](configs) | Arquivos prontos para copiar: `models.yml`, `config.yml` e `gateway.env.exemplo`. |
| [`tools/mock-freellmapi.mjs`](tools/mock-freellmapi.mjs) | Gateway mock (Node puro) que reproduz `/v1/models`, `/v1/chat/completions` (streaming, tool_calls) e grava cada requisição que o `omp` envia. |
| [`tools/evidence.json`](tools/evidence.json) | Resumo legível das capturas de tráfego usadas como prova. |
| [`../../scripts/setup-omp-freellmapi.mjs`](../../scripts/setup-omp-freellmapi.mjs) | Gerador/instalador: escreve `models.yml`, faz merge em `config.yml` e no `.env`, com `--dry-run` e backup. |

## TL;DR — os 6 achados que decidem a integração

| # | Achado | Consequência prática |
| --- | --- | --- |
| 1 | O `omp` fala **OpenAI Chat Completions** com um provider declarado em `~/.omp/agent/models.yml` (`api: openai-completions`, `baseUrl` terminando em `/v1`). | É exatamente o contrato que o FreeLLMAPI expõe na porta `3001`. Nada de proxy ou bridge no meio. |
| 2 | **`discovery` cria dependência do gateway no boot.** Com `discovery.type: openai-models-list` e o gateway fora do ar, o `omp` lista **zero** modelos e imprime *"Set an API key environment variable"* — apesar do `models.yml` existir. Com a lista **explícita** de `models:`, os modelos aparecem mesmo com o gateway desligado (a falha passa a ser só na hora da requisição). | **Prefira lista explícita.** É o cadastro "assertivo": previsível, offline-safe e sem metadados inventados. |
| 3 | Ids com **dois-pontos** (os perfis `auto:coding`, `auto:fast` do FreeLLMAPI) **não são selecionáveis** por `--model` (`Model "freellmapi/auto:coding" not found`), porque o `omp` interpreta `:sufixo` como *thinking level*. | Declare `auto:<chain>` no `models.yml` e use-o **por role** (`modelRoles.default: freellmapi/auto:coding`) — verificado: o corpo enviado leva `"model":"auto:coding"`. |
| 4 | O `omp` envia `max_completion_tokens`, `stream: true`, `stream_options.include_usage`, `reasoning_effort` e ~11 tools sem `strict`; o FreeLLMAPI **já normaliza tudo isso** (alias `max_completion_tokens`, `developer`→`system`, `xhigh`/`max`→`high` de `reasoning_effort`, droplist por provider, gate de contexto, gate de tools). | Compatibilidade é boa por construção: sem `disableStrictTools`, sem blocos `compat` manuais. |
| 5 | O `omp` funde **identidade de modelo por id** com o catálogo embutido. O id virtual `auto` herdou `reasoning: true` + `input: [text, image]` de outros fornecedores — e passou a mandar `reasoning_effort` e a aceitar imagens. | Declarar `auto` explicitamente com `reasoning: false` e `input: [text]` (ou `modelOverrides`) elimina o palpite. |
| 6 | O UA do `omp` é `omp/18.11.1`; o classificador do FreeLLMAPI conhece `pi-coding-agent`/`pi/…` mas **não** `omp`. | Envie `headers: { User-Agent: pi-coding-agent }` no provider para que o dashboard ("visto recentemente", analytics por cliente) reconheça o agente. |

## Reprodução da verificação (5 minutos)

```bash
# 1) o agent (precisa de Bun no PATH: npm install -g bun @oh-my-pi/pi-coding-agent)
omp --version                 # omp/18.11.1 nas medições deste estudo

# 2) gateway falso que fala o dialeto do FreeLLMAPI e grava o tráfego
node research/freellmapi-omp/tools/mock-freellmapi.mjs      # 0.0.0.0:3001

# 3) cadastro do provider (o script deste repo)
node scripts/setup-omp-freellmapi.mjs --url http://127.0.0.1:3001 \
  --api-key freellmapi-teste --dry-run

# 4) o que o agent resolve, e um chat de verdade
omp models freellmapi
omp -p --no-session --model freellmapi/auto "Reply with only OK"
#   -> cada requisição do omp fica em tools/captured/*.json
```

> Aviso de escopo: o FreeLLMAPI é *local-first, single-user* e o autor o posiciona como uso pessoal
> (revisão de ToS dos free tiers em maio/2026 no próprio repositório). Não exponha o gateway na
> internet aberta nem o aponte para multiusuário.
