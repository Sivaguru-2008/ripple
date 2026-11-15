// Test fixture: a scripted OpenAI-compatible chat endpoint, configured in TrueForge as a
// model provider for the integration test. Ripple itself never talks to it.
// Script: no read_file call yet -> call read_file; then -> call propose_write; then -> text.
import http from 'node:http';

const log = (...a) => {
  if (process.env.RIPPLE_MOCK_VERBOSE) console.log('[mock]', ...a);
};

function decide(messages, tools) {
  const names = (tools ?? []).map((t) => t.function?.name);
  const called = messages
    .filter((m) => m.role === 'assistant' && m.tool_calls)
    .flatMap((m) => m.tool_calls.map((c) => c.function.name));
  const pick = (n) => names.find((x) => x === n || x?.endsWith(n)) ?? n;
  if (!called.some((n) => n.endsWith('read_file'))) {
    return { tool: pick('read_file'), args: { path: 'README.md' } };
  }
  if (!called.some((n) => n.endsWith('propose_write'))) {
    return {
      tool: pick('propose_write'),
      args: { epoch: 0, path: 'README.md', edits: [{ start_line: 3, end_line: 2, new_text: 'Added by Ripple smoke test.' }] },
    };
  }
  const last = messages.filter((m) => m.role === 'tool').at(-1);
  return { text: `Done. Last tool result: ${String(last?.content).slice(0, 80)}` };
}

function reply(parsed, res) {
  const d = decide(parsed.messages ?? [], parsed.tools);
  log('decision', JSON.stringify(d));
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCall = d.tool && { id: `call_${Date.now()}`, type: 'function', function: { name: d.tool, arguments: JSON.stringify(d.args) } };
  const finish = d.text ? 'stop' : 'tool_calls';
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

  if (!parsed.stream) {
    const message = d.text ? { role: 'assistant', content: d.text } : { role: 'assistant', content: null, tool_calls: [toolCall] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, object: 'chat.completion', created, model: 'mock-1', choices: [{ index: 0, message, finish_reason: finish }], usage }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const chunk = (choices, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'mock-1', choices, ...extra })}\n\n`);
  if (d.text) {
    chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
    for (const piece of d.text.match(/.{1,12}/g)) chunk([{ index: 0, delta: { content: piece }, finish_reason: null }]);
  } else {
    chunk([{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }]);
  }
  chunk([{ index: 0, delta: {}, finish_reason: finish }]);
  chunk([], { usage });
  res.end('data: [DONE]\n\n');
}

/** Starts the mock on 127.0.0.1:port and resolves with the http.Server. */
export function startMockModel(port = 8792) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      log(req.method, req.url);
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-1', object: 'model' }] }));
        return;
      }
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // empty body
      }
      reply(parsed, res);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
