#!/usr/bin/env node
// Verificação do gerador de configuração do omp (scripts/setup-omp-freellmapi.mjs).
// Roda com: npm run test:setup-omp   (ou: node --test scripts/setup-omp-freellmapi.test.mjs)
//
// O que este teste garante:
//   1. dry-run não escreve nada;
//   2. arquivo novo sai com models explícitos (nada de discovery) e .env 0600;
//   3. merge preserva providers/roles/settings que já existiam (não rouba role
//      atribuído, não apaga sibling de mapa);
//   4. rerodar é idempotente e não duplica chaves YAML.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'setup-omp-freellmapi.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omp-setup-'));
}

function run(args, expectStatus = 0) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  assert.equal(res.status, expectStatus, `exit ${res.status}\n${res.stdout}\n${res.stderr}`);
  return `${res.stdout}${res.stderr}`;
}

const baseArgs = dir => ['--agent-dir', dir, '--url', 'http://127.0.0.1:3001', '--api-key', 'freellmapi-teste'];

test('--dry-run não escreve arquivos', () => {
  const dir = tmpDir();
  run([...baseArgs(dir), '--dry-run']);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('arquivo novo: provider explícito, sem discovery, e .env com permissão 0600', () => {
  const dir = tmpDir();
  run(baseArgs(dir));

  const models = fs.readFileSync(path.join(dir, 'models.yml'), 'utf8');
  assert.match(models, /^providers:/m);
  assert.match(models, /freellmapi:\n\s+name: FreeLLMAPI/);
  assert.match(models, /baseUrl: http:\/\/127\.0\.0\.1:3001\/v1/);
  assert.match(models, /api: openai-completions/);
  assert.match(models, /- id: auto$/m);
  assert.match(models, /- id: auto:coding$/m);
  assert.match(models, /- id: auto:fast$/m);
  // a escolha de projeto: lista explícita, nunca discovery (que derruba o provider offline)
  assert.doesNotMatch(models, /discovery:/);
  // metadados que evitam o palpite de capacidade do catálogo embutido
  assert.match(models, /reasoning: false/);
  assert.match(models, /input: \[text\]/);
  // headers que fazem o gateway reconhecer o cliente
  assert.match(models, /User-Agent: pi-coding-agent/);
  assert.match(models, /X-FreeLLM-Task-Type: code/);

  const config = fs.readFileSync(path.join(dir, 'config.yml'), 'utf8');
  assert.match(config, /modelRoles:\n(?:\s*#.*\n)*\s+default: freellmapi\/auto/);
  assert.match(config, /slow: freellmapi\/auto:coding/);
  assert.match(config, /smol: freellmapi\/auto:fast/);
  assert.match(config, /maxInFlightRequests:\n\s+freellmapi: 4/);

  const env = path.join(dir, '.env');
  assert.match(fs.readFileSync(env, 'utf8'), /^FREELLMAPI_API_KEY=freellmapi-teste$/m);
  assert.equal(fs.statSync(env).mode & 0o777, 0o600);
});

test('merge preserva o que já existia e não rouba role atribuído', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'models.yml'), `providers:
  ollama:
    baseUrl: http://127.0.0.1:11434/v1
    api: openai-completions
    auth: none
    models:
      - id: qwen2.5-coder:14b
        name: Qwen2.5 Coder 14B (local)

  freellmapi:
    baseUrl: http://127.0.0.1:9999/v1
    models:
      - id: auto
        name: config antiga
`);
  fs.writeFileSync(path.join(dir, 'config.yml'), `theme:
  dark: catppuccin-macchiato

modelRoles:
  default: ollama/qwen2.5-coder:14b
  commit: ollama/qwen2.5-coder:14b

providers:
  maxInFlightRequests:
    ollama: 2
`);

  run(baseArgs(dir));

  const models = fs.readFileSync(path.join(dir, 'models.yml'), 'utf8');
  assert.match(models, /qwen2\.5-coder:14b/, 'provider existente preservado');
  assert.match(models, /# minha config|providers:/);
  assert.match(models, /baseUrl: http:\/\/127\.0\.0\.1:3001\/v1/, 'provider antigo substituído');
  assert.doesNotMatch(models, /127\.0\.0\.1:9999/, 'sem restos do provider antigo');
  assert.equal(models.match(/freellmapi:/g).length, 1, 'bloco do provider não duplicado');

  const config = fs.readFileSync(path.join(dir, 'config.yml'), 'utf8');
  assert.match(config, /dark: catppuccin-macchiato/, 'settings não relacionados intactos');
  assert.match(config, /^  default: ollama\/qwen2\.5-coder:14b$/m, 'role default já atribuído não é roubado');
  assert.match(config, /^  commit: ollama\/qwen2\.5-coder:14b$/m, 'role commit já atribuído não é roubado');
  assert.match(config, /^  slow: freellmapi\/auto:coding$/m, 'roles livres preenchidos');
  assert.match(config, /ollama: 2/, 'sibling de mapa preservado');
  assert.match(config, /freellmapi: 4/);
  assert.equal(config.match(/^  default:/gm).length, 1, 'nenhuma chave duplicada');
});

test('--force sobrescreve roles existentes', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.yml'), 'modelRoles:\n  default: ollama/llama\n');
  run([...baseArgs(dir), '--force']);
  const config = fs.readFileSync(path.join(dir, 'config.yml'), 'utf8');
  assert.match(config, /^  default: freellmapi\/auto$/m);
  assert.doesNotMatch(config, /ollama\/llama/);
});

test('rerodar é idempotente', () => {
  const dir = tmpDir();
  run(baseArgs(dir));
  const before = {
    models: fs.readFileSync(path.join(dir, 'models.yml'), 'utf8'),
    config: fs.readFileSync(path.join(dir, 'config.yml'), 'utf8'),
  };
  run(baseArgs(dir));
  assert.equal(fs.readFileSync(path.join(dir, 'models.yml'), 'utf8'), before.models);
  assert.equal(fs.readFileSync(path.join(dir, 'config.yml'), 'utf8'), before.config);
  assert.deepEqual(
    fs.readdirSync(dir).filter(f => f.includes('.bak-')),
    [],
    'sem backup quando nada muda',
  );
});

test('--no-roles e --no-env respeitam o pedido', () => {
  const dir = tmpDir();
  run([...baseArgs(dir), '--no-roles', '--no-env']);
  assert.ok(fs.existsSync(path.join(dir, 'models.yml')));
  assert.ok(!fs.existsSync(path.join(dir, 'config.yml')));
  assert.ok(!fs.existsSync(path.join(dir, '.env')));
});

test('--no-chains remove os ids auto:<perfil> e reaponta os roles para auto', () => {
  const dir = tmpDir();
  run([...baseArgs(dir), '--no-chains']);
  const models = fs.readFileSync(path.join(dir, 'models.yml'), 'utf8');
  assert.doesNotMatch(models, /auto:/);
  const config = fs.readFileSync(path.join(dir, 'config.yml'), 'utf8');
  assert.match(config, /slow: freellmapi\/auto$/m);
});
