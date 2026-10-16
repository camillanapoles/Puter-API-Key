#!/usr/bin/env node
// Cadastra um gateway FreeLLMAPI como provider do oh-my-pi (omp).
//
//   node scripts/setup-omp-freellmapi.mjs --url http://127.0.0.1:3001 \
//     --api-key freellmapi-xxxx [--chains coding,fast] [--dry-run]
//
// O que ele faz (com backup + merge estrutural, sem sobrescrever o que já existe):
//   1. ~/.omp/agent/models.yml  -> providers.freellmapi com LISTA EXPLÍCITA de modelos
//      (nada de `discovery`: com o gateway fora do ar o provider sumiria do omp);
//   2. ~/.omp/agent/config.yml  -> merge de modelRoles + providers.maxInFlightRequests;
//   3. ~/.omp/agent/.env (0600) -> FREELLMAPI_API_KEY=...
//
// Use --dry-run para ver tudo antes de escrever. --agent-dir / PI_CODING_AGENT_DIR
// permitem testar sem sujar a configuração real do omp.
//
// Referência: research/freellmapi-omp/ (investigação e achados que motivam cada escolha).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
};

const HELP = `Uso: node scripts/setup-omp-freellmapi.mjs [opções]

  --url <url>            Gateway FreeLLMAPI (padrão: http://127.0.0.1:3001)
  --api-key <chave>      Chave unificada freellmapi-… (padrão: env FREELLMAPI_API_KEY)
  --api-key-env <nome>   Nome da env var gravada no .env (padrão: FREELLMAPI_API_KEY)
  --provider <id>        Id do provider no omp (padrão: freellmapi)
  --chains <a,b>         Perfis/cadeias nomeadas do gateway -> ids auto:<nome>
                         (padrão: coding,fast)
  --no-chains            Não declara auto:<nome> nenhum
  --agent-dir <dir>      Diretório do agente do omp (padrão: ~/.omp/agent,
                         ou $PI_CODING_AGENT_DIR)
  --no-roles             Não mexe no config.yml
  --no-env               Não escreve o .env (você exporta a chave na mão)
  --dry-run              Mostra o que seria escrito e não toca em nada
  --force                Não pergunta nada (sobrescreve blocos gerenciados)
  -h, --help             Esta ajuda

Reinicie o omp após rodar (env e descoberta não são recarregados a quente).
Valide com:  omp models freellmapi   &&   omp -p --model freellmapi/auto "Reply with only OK"`;

function parseArgs(argv) {
  const out = { chains: 'coding,fast' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`faltou valor para ${a}`);
      i += 1;
      return v;
    };
    switch (a) {
      case '--url': out.url = next(); break;
      case '--api-key': out.apiKey = next(); break;
      case '--api-key-env': out.apiKeyEnv = next(); break;
      case '--provider': out.provider = next(); break;
      case '--chains': out.chains = next(); break;
      case '--no-chains': out.chains = ''; break;
      case '--agent-dir': out.agentDir = next(); break;
      case '--no-roles': out.noRoles = true; break;
      case '--no-env': out.noEnv = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--force': out.force = true; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`opção desconhecida: ${a}`);
    }
  }
  return out;
}

// ── utilidades de arquivo ────────────────────────────────────────────────────
function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, dest);
  console.log(C.dim(`  backup: ${dest}`));
}

function writeFile(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = content.endsWith('\n') ? content : `${content}\n`;
  fs.writeFileSync(file, body, { mode: mode ?? 0o644 });
  if (mode) fs.chmodSync(file, mode);
}

// ── merge estrutural de YAML em nível de bloco ───────────────────────────────
// Não é um parser YAML: mexe só no bloco que nos interessa, preservando o resto
// (comentários, ordem, outros providers). É o mesmo espírito dos geradores do
// próprio FreeLLMAPI.
function indentOf(line) { return line.match(/^[ \t]*/)[0].replace(/\t/g, '  ').length; }

// Localiza a linha `key:` com indentação EXATA dentro de [from, to).
function locateKey(lines, from, to, indent, key) {
  // "chave:" sozinha (bloco), "chave: valor" (escalar) ou "chave: # comentário"
  const re = new RegExp(`^\\s*${escapeRe(key)}:(\\s.*)?$`);
  for (let i = from; i < to; i += 1) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) !== indent) continue;
    if (re.test(lines[i])) return i;
  }
  return null;
}

// Fim do bloco iniciado em `start` (primeira linha não comentada com indent <=).
function blockEnd(lines, start, indent, to) {
  for (let i = start + 1; i < to; i += 1) {
    const l = lines[i];
    if (l.trim() === '' || l.trimStart().startsWith('#')) continue;
    if (indentOf(l) <= indent) return i;
  }
  return to;
}

function trimTrailingBlanks(lines, from, to) {
  let end = to;
  while (end > from && lines[end - 1].trim() === '') end -= 1;
  return end;
}

function renderKey(key, value, indent, indentSize) {
  const pad = ' '.repeat(indent);
  if (typeof value === 'string') return [`${pad}${key}: ${value}`];
  return [`${pad}${key}:`, ...value.map(l => (l.trim() === '' ? '' : `${pad}${' '.repeat(indentSize)}${l}`))];
}

/**
 * Insere/atualiza a chave em `path` (ex.: ['providers','freellmapi']) preservando
 * o resto do arquivo — comentários, ordem e irmãos que já existiam. Ancestrais que
 * faltarem são criados. `value` é um escalar (string) ou as linhas filhas
 * (indentação RELATIVA começando em 0).
 */
function upsertPath(text, path, value, indentSize = 2) {
  const lines = text === '' ? [] : text.split('\n');
  return applyPath(lines, 0, lines.length, 0, path, value, indentSize).join('\n');
}

/** O caminho já existe no texto? (usado para não sobrescrever escolha do usuário) */
function hasPath(text, path, indentSize = 2) {
  const lines = text === '' ? [] : text.split('\n');
  let from = 0;
  let to = lines.length;
  let indent = 0;
  for (const key of path) {
    const found = locateKey(lines, from, to, indent, key);
    if (found === null) return false;
    from = found + 1;
    to = blockEnd(lines, found, indent, to);
    indent += indentSize;
  }
  return true;
}

function applyPath(lines, from, to, indent, path, value, indentSize) {
  const [key, ...rest] = path;
  const found = locateKey(lines, from, to, indent, key);

  if (rest.length === 0) {
    const rendered = renderKey(key, value, indent, indentSize);
    if (found !== null) {
      const end = blockEnd(lines, found, indent, to);
      return [...lines.slice(from, found), ...rendered, ...lines.slice(end, to)];
    }
    const at = trimTrailingBlanks(lines, from, to);
    const sep = at > from ? [''] : [];
    return [...lines.slice(from, at), ...sep, ...rendered, ...lines.slice(at, to)];
  }

  if (found !== null) {
    const end = blockEnd(lines, found, indent, to);
    const inner = applyPath(lines, found + 1, end, indent + indentSize, rest, value, indentSize);
    return [...lines.slice(from, found + 1), ...inner, ...lines.slice(end, to)];
  }

  const inner = applyPath([], 0, 0, indent + indentSize, rest, value, indentSize);
  const rendered = [`${' '.repeat(indent)}${key}:`, ...inner];
  const at = trimTrailingBlanks(lines, from, to);
  const sep = at > from ? [''] : [];
  return [...lines.slice(from, at), ...sep, ...rendered, ...lines.slice(at, to)];
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ── geração dos blocos ───────────────────────────────────────────────────────
// Filhos do bloco do provider (indentação relativa começando em 0).
function providerBody({ url, apiKeyEnv, chains }) {
  const models = [
    { id: 'auto', name: 'FreeLLMAPI Auto', ctx: 200000, max: 32000 },
    ...chains.map(c => ({
      id: `auto:${c}`,
      name: `FreeLLMAPI Auto — cadeia ${c}`,
      ctx: c === 'fast' ? 128000 : 200000,
      max: c === 'fast' ? 16000 : 32000,
    })),
  ];
  const lines = [
    `name: FreeLLMAPI`,
    `baseUrl: ${v1(url)}`,
    `api: openai-completions`,
    `apiKey: ${apiKeyEnv}`,
    `headers:`,
    `  # o classificador de cliente do gateway reconhece pi-coding-agent, não omp/x`,
    `  User-Agent: pi-coding-agent`,
    `  # enviesa os pesos do router para código (30% de um eixo)`,
    `  X-FreeLLM-Task-Type: code`,
    `models:`,
  ];
  for (const m of models) {
    lines.push(
      `  - id: ${m.id}`,
      `    name: ${m.name}`,
      `    # reasoning:false => o omp não envia reasoning_effort: a cadeia pode ter`,
      `    # modelos que não aceitam o parâmetro`,
      `    reasoning: false`,
      `    input: [text]`,
      `    supportsTools: true`,
      `    contextWindow: ${m.ctx}`,
      `    maxTokens: ${m.max}`,
      `    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`,
    );
  }
  return lines;
}

// Roles sugeridos para o gateway (auto = cadeia ativa; auto:<nome> = cadeia nomeada).
function roleMap({ provider, chains }) {
  const has = name => chains.includes(name);
  const fast = has('fast') ? 'auto:fast' : 'auto';
  const coding = has('coding') ? 'auto:coding' : 'auto';
  return {
    default: `${provider}/auto`,
    slow: `${provider}/${coding}`,
    plan: `${provider}/${coding}`,
    smol: `${provider}/${fast}`,
    tiny: `${provider}/${fast}`,
    commit: `${provider}/${fast}`,
    task: `${provider}/auto`,
  };
}

function v1(url) {
  const trimmed = String(url).trim().replace(/\/+$/, '');
  // URL token (cliente sem header): /v1/t/<token> já é o caminho completo
  if (/\/v1(\/t\/[^/]+)?$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

function rootUrl(url) {
  return v1(url).replace(/\/v1(\/t\/[^/]+)?$/, '');
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) { console.error(C.red(err.message)); console.error(HELP); process.exit(2); }
  if (args.help) { console.log(HELP); return; }

  const provider = args.provider || 'freellmapi';
  const url = args.url || 'http://127.0.0.1:3001';
  const apiKeyEnv = args.apiKeyEnv || 'FREELLMAPI_API_KEY';
  const apiKey = args.apiKey || process.env[apiKeyEnv] || '';
  const chains = (args.chains || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const agentDir = args.agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.omp', 'agent');
  const modelsFile = path.join(agentDir, 'models.yml');
  const configFile = path.join(agentDir, 'config.yml');
  const envFile = path.join(agentDir, '.env');

  console.log(C.bold(`\nFreeLLMAPI -> omp`));
  console.log(`  gateway ....... ${C.cyan(v1(url))}`);
  console.log(`  agent dir ..... ${agentDir}`);
  console.log(`  provider id ... ${provider}`);
  console.log(`  cadeias ....... ${chains.length ? chains.map(c => `auto:${c}`).join(', ') : '(nenhuma)'}`);
  console.log(`  chave ......... ${apiKey ? C.green('recebida') : C.yellow('AUSENTE (só o nome da env var será gravado)')}`);
  if (args.dryRun) console.log(C.yellow('  modo .......... DRY-RUN (nada será escrito)'));

  // ── 1. models.yml ──────────────────────────────────────────────────────────
  const existingModels = readIfExists(modelsFile) ?? '';
  const nextModels = upsertPath(existingModels, ['providers', provider], providerBody({ url, apiKeyEnv, chains }));

  // ── 2. config.yml ──────────────────────────────────────────────────────────
  const existingConfig = readIfExists(configFile) ?? '';
  let nextConfig = existingConfig;
  const roles = roleMap({ provider, chains });
  const skipped = [];
  if (!args.noRoles) {
    if (!hasPath(nextConfig, ['modelRoles'])) {
      // bloco novo: escreve tudo de uma vez, com os comentários que explicam os ':'
      nextConfig = upsertPath(nextConfig, ['modelRoles'], [
        `# FreeLLMAPI: auto = cadeia ativa do gateway; auto:<nome> = cadeia nomeada`,
        `# Ids com ':' só valem por role (--model trata ':' como thinking level)`,
        ...Object.entries(roles).map(([role, selector]) => `${role}: ${selector}`),
      ]);
    } else {
      for (const [role, selector] of Object.entries(roles)) {
        // Não rouba atribuição que o usuário já tinha — a não ser com --force.
        if (!args.force && hasPath(nextConfig, ['modelRoles', role])) { skipped.push(role); continue; }
        nextConfig = upsertPath(nextConfig, ['modelRoles', role], selector);
      }
    }
    if (!args.force && !hasPath(nextConfig, ['providers', 'maxInFlightRequests', provider])) {
      nextConfig = upsertPath(nextConfig, ['providers', 'maxInFlightRequests', provider], '4');
    }
  }

  // ── 3. .env ────────────────────────────────────────────────────────────────
  const existingEnv = readIfExists(envFile) ?? '';
  let nextEnv = existingEnv;
  if (!args.noEnv && apiKey) {
    const line = `${apiKeyEnv}=${apiKey}`;
    const re = new RegExp(`^\\s*(export\\s+)?${escapeRe(apiKeyEnv)}=.*$`, 'm');
    nextEnv = re.test(existingEnv) ? existingEnv.replace(re, line) : `${existingEnv.replace(/\s*$/, '')}${existingEnv.trim() ? '\n' : ''}${line}\n`;
  }

  // Comparação/gravação normalizada: o arquivo gravado sempre termina com um \n,
  // então "igual" precisa ignorar só isso (senão rerodar geraria backup à toa).
  const norm = t => (t === '' ? '' : `${t.replace(/\s+$/, '')}\n`);
  const modelsBefore = norm(existingModels); const modelsAfter = norm(nextModels);
  const configBefore = norm(existingConfig); const configAfter = norm(nextConfig);
  const envBefore = norm(existingEnv); const envAfter = norm(nextEnv);

  const show = (label, before, after, file) => {
    if (before === after) { console.log(C.dim(`\n${label}: sem mudanças (${file})`)); return; }
    console.log(C.bold(`\n${label} (${file})`));
    if (args.dryRun) {
      console.log(C.dim('  ── conteúdo final ──'));
      console.log(after.split('\n').map(l => `  ${l}`).join('\n'));
    } else {
      console.log(C.green('  atualizado'));
    }
  };

  show('models.yml', modelsBefore, modelsAfter, modelsFile);
  if (!args.noRoles) show('config.yml', configBefore, configAfter, configFile);
  if (!args.noEnv && apiKey) show('.env', envBefore, envAfter, envFile);
  else if (!args.noEnv) console.log(C.yellow(`\n.env: ignorado (nenhuma chave fornecida; export ${apiKeyEnv}=... antes de rodar o omp)`));

  if (args.dryRun) { console.log(C.dim('\nNada foi escrito. Rode sem --dry-run para aplicar.\n')); return; }

  if (modelsBefore !== modelsAfter) { backup(modelsFile); writeFile(modelsFile, modelsAfter); }
  if (!args.noRoles && configBefore !== configAfter) { backup(configFile); writeFile(configFile, configAfter); }
  if (!args.noEnv && apiKey && envBefore !== envAfter) { backup(envFile); writeFile(envFile, envAfter, 0o600); }

  // ── validação ──────────────────────────────────────────────────────────────
  console.log(C.bold('\nPróximos passos'));
  console.log(`  1. confirme que o gateway responde na raiz ${C.cyan(rootUrl(url))} (dashboard -> Keys -> chave unificada)`);
  console.log(`  2. ${C.cyan('omp models ' + provider)}                # o omp deve listar auto${chains.length ? ' e ' + chains.map(c => `auto:${c}`).join(', ') : ''}`);
  console.log(`  3. ${C.cyan(`omp -p --no-session --model ${provider}/auto "Reply with only OK"`)}`);
  console.log(`  4. perfis (auto:<nome>) vêm de modelRoles no config.yml — use-os por role, não em --model`);
  console.log(C.dim(`  Reinicie qualquer sessão de omp aberta: env e catálogo não recarregam a quente.`));
  console.log(C.dim(`  Detalhes, otimizações do gateway e troubleshooting: research/freellmapi-omp/\n`));
}

main().catch(err => { console.error(C.red(`erro: ${err.message}`)); process.exit(1); });
