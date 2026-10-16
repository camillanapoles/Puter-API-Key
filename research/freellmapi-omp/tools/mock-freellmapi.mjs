// Mock FreeLLMAPI gateway: mimics the shapes that matter for an omp integration.
//  - GET  /v1/models            -> freellmapi-shaped catalog (auto + auto:<profile> + per-model rows)
//  - POST /v1/chat/completions  -> OpenAI chat completions, streaming + non-streaming, with X-Routed-Via
//  - OPTIONS                    -> CORS
// Every request body is dumped to ./captured/NN-<path>.json so we can see exactly
// what omp sends on the wire.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3001);
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'captured');
fs.mkdirSync(OUT, { recursive: true });
let seq = 0;

const CATALOG = [
  { id: 'auto', object: 'model', created: 0, owned_by: 'freellmapi', name: 'Auto Router', context_window: 1048576, context_length: 1048576, available: true, execution_status: 'ready' },
  { id: 'auto:coding', object: 'model', created: 0, owned_by: 'freellmapi', name: 'Auto (coding chain)', context_window: 262144, context_length: 262144, available: true, execution_status: 'ready' },
  { id: 'claude-sonnet-4-5', object: 'model', created: 0, owned_by: 'freellmapi', name: 'Claude Sonnet 4.5', context_window: 200000, context_length: 200000, available: true, execution_status: 'ready' },
  { id: 'gemini-3.6-flash', object: 'model', created: 0, owned_by: 'freellmapi', name: 'Gemini 3.6 Flash', context_window: 1048576, context_length: 1048576, available: true, execution_status: 'ready' },
  { id: 'deepseek-v4-flash', object: 'model', created: 0, owned_by: 'freellmapi', name: 'DeepSeek V4 Flash', context_window: 131072, context_length: 131072, available: false, execution_status: 'exhausted' },
];

function capture(name, body) {
  seq += 1;
  const file = path.join(OUT, `${String(seq).padStart(2, '0')}-${name}.json`);
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

function sse(res, chunks) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-routed-via': 'mock/gemini-3.6-flash',
    'x-fallback-attempts': '0',
  });
  let i = 0;
  const tick = () => {
    if (i >= chunks.length) {
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
    setTimeout(tick, 5);
  };
  tick();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const auth = req.headers.authorization || '';
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = raw; }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      capture('models-request', { url: req.url, headers: req.headers });
      res.writeHead(auth.includes('freellmapi-') ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: auth.includes('freellmapi-') ? CATALOG : [] }));
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/responses')) {
      capture(parsed?.stream ? 'chat-stream' : 'chat', { url: req.url, headers: req.headers, body: parsed });

      // Tool-loop mode: first turn (no tool message yet) -> emit a bash tool call;
      // second turn (tool result present) -> emit final text.
      const msgs = parsed?.messages ?? [];
      const hasToolResult = msgs.some(m => m.role === 'tool');
      const wantsTool = JSON.stringify(msgs).includes('TOOLTEST');
      if (wantsTool && !hasToolResult && parsed?.stream && (parsed?.tools ?? []).length > 0) {
        const id = 'chatcmpl-mock-tool';
        sse(res, [
          { id, object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
          { id, object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'bash', arguments: '{"command":"echo omp-tool-loop-ok"}' } }] }, finish_reason: null }] },
          { id, object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ]);
        return;
      }
      if (wantsTool && hasToolResult && parsed?.stream) {
        const id = 'chatcmpl-mock-done';
        sse(res, [
          { id, object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
          { id, object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [{ index: 0, delta: { content: 'DONE' }, finish_reason: null }] },
          { id, object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]);
        return;
      }

      if (parsed?.stream) {
        const id = 'chatcmpl-mock';
        sse(res, [
          { id, object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
          { id, object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] },
          { id, object: 'chat.completion.chunk', created: 0, model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } },
        ]);
        return;
      }

      res.writeHead(200, {
        'content-type': 'application/json',
        'x-routed-via': 'mock/gemini-3.6-flash',
        'x-fallback-attempts': '0',
        'x-fallback-trail': '',
      });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 0,
        model: parsed?.model ?? 'auto',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
      }));
      return;
    }

    capture('other', { method: req.method, url: req.url, headers: req.headers, body: parsed });
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no mock route for ${req.method} ${url.pathname}`, type: 'invalid_request_error' } }));
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`mock freellmapi on http://0.0.0.0:${PORT}`));
