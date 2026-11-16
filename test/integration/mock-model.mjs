// Test fixture: a scripted OpenAI-compatible chat endpoint, configured in TrueForge as a
// model provider for the integration test. Ripple itself never talks to it.
// Script: inline agent (replace_selection offered) -> Task A replacement, then text.
// Otherwise: read_file, then propose_write, then text. "SLOW" in the request streams slowly.
import http from 'node:http';

const log = (...a) => {
  if (process.env.RIPPLE_MOCK_VERBOSE) console.log('[mock]', ...a);
};

/** Task A edit the mock makes to the selected get_debug_flag lines: two separate hunks. */
function taskAReplacement(selected) {
  return selected
    .replace('The default is ``False``.', 'The default is ``False``.\n    The values ``0``, ``false``, ``no``, ``off`` and ``n`` (any case) are false.')
    .replace('{"0", "false", "no"}', '{"0", "false", "no", "off", "n"}');
}

function decide(messages, tools) {
  const names = (tools ?? []).map((t) => t.function?.name);
  const called = messages
    .filter((m) => m.role === 'assistant' && m.tool_calls)
    .flatMap((m) => m.tool_calls.map((c) => c.function.name));
  const pick = (n) => names.find((x) => x === n || x?.endsWith(n)) ?? n;
  const user = String(messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
  const last = messages.filter((m) => m.role === 'tool').at(-1);

  if (names.some((n) => n?.endsWith('replace_selection'))) {
    if (!called.some((n) => n.endsWith('replace_selection'))) {
      const code = /<selected_lines>\n([\s\S]*?)\n<\/selected_lines>/.exec(user)?.[1] ?? '';
      return { tool: pick('replace_selection'), args: { new_text: taskAReplacement(code) }, slow: user.includes('SLOW') };
    }
    return { text: `Result: ${String(last?.content).slice(0, 120)}` };
  }
  if (!called.some((n) => n.endsWith('read_file'))) {
    return { tool: pick('read_file'), args: { path: 'README.md' } };
  }
  if (!called.some((n) => n.endsWith('propose_write'))) {
    return {
      tool: pick('propose_write'),
      args: { path: 'README.md', edits: [{ old_text: 'Hello', new_text: 'Hello\nAdded by Ripple smoke test.' }] },
    };
  }
  return { text: `Done. Last tool result: ${String(last?.content).slice(0, 80)}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reply(parsed, res) {
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
    // Stream the arguments in fragments, as real providers do. `slow` spreads them over ~8 s.
    const args = toolCall.function.arguments;
    const head = { index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.function.name, arguments: '' } };
    chunk([{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [head] }, finish_reason: null }]);
    const size = Math.max(8, Math.ceil(args.length / 20));
    for (let k = 0; k < args.length; k += size) {
      if (d.slow) await sleep(400);
      if (res.destroyed) return;
      chunk([{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(k, k + size) } }] }, finish_reason: null }]);
    }
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
      void reply(parsed, res);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
