// Lightweight local adapter that keeps Gemini thought signatures across TrueForge turn cycles.
//
// Gemini 3 models attach `extra_content.google.thought_signature` to each tool call and
// reject the follow-up request (HTTP 400) when it is missing. TrueForge speaks plain
// OpenAI chat-completions and drops that field, so this adapter sits between TrueForge
// and Google AI Studio: it remembers the signature of every tool call it sees in a
// response (streamed or not) and puts it back on the matching tool call in later requests.
//
// It is a model endpoint that TrueForge is configured with (provider baseUrl
// http://127.0.0.1:8794/v1). The extension never talks to it. It holds no key: the
// Authorization header TrueForge sends is forwarded unchanged and never logged.
import * as http from 'node:http';

const TARGET_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const PORT = Number(process.env.GEMINI_PROXY_PORT ?? 8794);
const VERBOSE = process.env.GEMINI_PROXY_QUIET !== '1';
const MAX_SIGNATURES = 5000;

// tool-call id -> extra_content, plus a name+arguments key in case ids are rewritten.
const signatures = new Map();

function remember(key, extra) {
  if (!key || !extra) return;
  signatures.delete(key);
  signatures.set(key, extra);
  if (signatures.size > MAX_SIGNATURES) signatures.delete(signatures.keys().next().value);
}

function contentKey(name, args) {
  return `fn:${name ?? ''}:${typeof args === 'string' ? args : JSON.stringify(args ?? '')}`;
}

/** Puts cached signatures back on assistant tool calls. Returns [attached, missing]. */
export function attachSignatures(body) {
  let attached = 0;
  let missing = 0;
  if (!body || !Array.isArray(body.messages)) return [attached, missing];
  for (const msg of body.messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    // Gemini signs only the first call of a parallel batch, so only that one can be "missing".
    msg.tool_calls.forEach((tc, index) => {
      if (tc.extra_content) return;
      const extra =
        signatures.get(tc.id) ?? signatures.get(contentKey(tc.function?.name, tc.function?.arguments));
      if (extra) {
        tc.extra_content = extra;
        attached++;
      } else if (index === 0) {
        missing++;
      }
    });
  }
  return [attached, missing];
}

/**
 * Groq rejects assistant messages that carry `reasoning_content` (HTTP 400, "property
 * 'reasoning_content' is unsupported"), which TrueForge echoes back for reasoning models.
 * Returns the number of messages changed.
 */
export function stripReasoning(body) {
  let changed = 0;
  if (!body || !Array.isArray(body.messages)) return changed;
  for (const msg of body.messages) {
    if (msg.role === 'assistant' && 'reasoning_content' in msg) {
      delete msg.reasoning_content;
      changed++;
    }
  }
  return changed;
}

/** Collects tool calls from streamed chunks; a call's arguments arrive in fragments. */
export function createStreamCollector() {
  const calls = new Map(); // `${choice}:${index}` -> { id, name, args, extra }
  let pending = '';
  const onEvent = (json) => {
    for (const choice of json.choices ?? []) {
      const toolCalls = choice.delta?.tool_calls ?? choice.message?.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      toolCalls.forEach((tc, position) => {
        // Gemini may repeat index 0 for every call in a batch; a new id starts a new call.
        let key = `${choice.index ?? 0}:${tc.index ?? position}`;
        const existing = calls.get(key);
        if (existing && tc.id && existing.id && tc.id !== existing.id) key = `${key}:${tc.id}`;
        const call = calls.get(key) ?? { id: '', name: '', args: '', extra: undefined };
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') call.args += tc.function.arguments;
        if (tc.extra_content) call.extra = tc.extra_content;
        calls.set(key, call);
      });
    }
  };
  return {
    push(text) {
      pending += text;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          onEvent(JSON.parse(data));
        } catch {
          // partial or non-JSON event; ignore
        }
      }
    },
    /** Stores what was collected. Returns the number of signatures captured. */
    finish() {
      let captured = 0;
      for (const call of calls.values()) {
        if (!call.extra) continue;
        remember(call.id, call.extra);
        remember(contentKey(call.name, call.args), call.extra);
        captured++;
      }
      return captured;
    },
  };
}

function captureFromJson(json) {
  let captured = 0;
  for (const choice of json.choices ?? []) {
    for (const tc of choice.message?.tool_calls ?? []) {
      if (!tc.extra_content) continue;
      remember(tc.id, tc.extra_content);
      remember(contentKey(tc.function?.name, tc.function?.arguments), tc.extra_content);
      captured++;
    }
  }
  return captured;
}

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'content-encoding',
  'accept-encoding',
  'keep-alive',
]);

function forwardHeaders(source) {
  const out = {};
  for (const [name, value] of source) {
    if (!HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) out[name] = value;
  }
  return out;
}

export function startGeminiProxy(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, signatures: signatures.size }));
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString('utf-8');

      let bodyObj = null;
      try {
        bodyObj = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        bodyObj = null;
      }
      // Route: /groq/v1/... goes to Groq, everything else to Google AI Studio.
      const isGroq = (req.url ?? '').startsWith('/groq/');
      let attached = 0;
      let missing = 0;
      if (isGroq) attached = stripReasoning(bodyObj);
      else [attached, missing] = attachSignatures(bodyObj);

      // TrueForge calls <baseUrl>/chat/completions with baseUrl ending in /v1; neither upstream base has it.
      const upstreamPath = (req.url ?? '/').replace(/^\/groq(?=\/)/, '').replace(/^\/v1(?=\/|$)/, '');
      const targetBase = isGroq ? GROQ_BASE : TARGET_BASE;
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

      try {
        const upstream = await fetch(`${targetBase}${upstreamPath}`, {
          method: req.method,
          headers: forwardHeaders(Object.entries(req.headers)),
          body: hasBody ? (bodyObj ? JSON.stringify(bodyObj) : rawBody) : undefined,
        });
        const responseHeaders = forwardHeaders(upstream.headers.entries());
        const isStream = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
        let captured = 0;

        if (isStream && upstream.body) {
          res.writeHead(upstream.status, responseHeaders);
          const collector = createStreamCollector();
          const decoder = new TextDecoder();
          for await (const chunk of upstream.body) {
            res.write(chunk);
            collector.push(decoder.decode(chunk, { stream: true }));
          }
          collector.push('\n');
          captured = collector.finish();
          res.end();
        } else {
          const text = await upstream.text();
          try {
            captured = captureFromJson(JSON.parse(text));
          } catch {
            // not JSON; forward as-is
          }
          res.writeHead(upstream.status, responseHeaders);
          res.end(text);
          if (VERBOSE && upstream.status >= 400) {
            console.log(`[gemini-proxy] upstream error body: ${text.slice(0, 600)}`);
          }
        }

        if (VERBOSE) {
          console.log(
            `[gemini-proxy] ${isGroq ? 'groq' : 'gemini'} ${req.method} ${upstreamPath} -> ${upstream.status}` +
              ` stream=${isStream} messages=${bodyObj?.messages?.length ?? 0}` +
              ` attached=${attached} missing=${missing} captured=${captured}`,
          );
        }
      } catch (err) {
        if (VERBOSE) console.log(`[gemini-proxy] ${req.method} ${upstreamPath} failed: ${String(err)}`);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `gemini-proxy: ${String(err)}` } }));
      }
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ port, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/gemini-proxy.mjs')) {
  startGeminiProxy(PORT).then(({ port }) => {
    console.log(`Gemini thought-signature proxy listening on http://127.0.0.1:${port}`);
  });
}
