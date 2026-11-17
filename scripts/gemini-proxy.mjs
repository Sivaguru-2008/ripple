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

// GEMINI_PROXY_TARGET and GEMINI_PROXY_RETRY_MS exist for testing against a fake provider.
const TARGET_BASE = process.env.GEMINI_PROXY_TARGET ?? 'https://generativelanguage.googleapis.com/v1beta/openai';
const RETRY_MS = Number(process.env.GEMINI_PROXY_RETRY_MS ?? 0);
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const ROUTES = {
  groq: GROQ_BASE,
  openrouter: OPENROUTER_BASE,
  ollama: 'http://127.0.0.1:11434/v1',
  mistral: 'https://api.mistral.ai/v1',
};
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

/** Rough size of a request (characters / 4), split so the log shows what dominates. */
function sizeOf(body) {
  if (!body) return 0;
  const tok = (v) => Math.ceil(JSON.stringify(v ?? '').length / 4);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const toolResults = tok(msgs.filter((m) => m.role === 'tool'));
  return `${tok(msgs) + tok(body.tools)} (tools=${tok(body.tools)} system=${tok(msgs.filter((m) => m.role === 'system'))} toolResults=${toolResults} n=${msgs.length})`;
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
  let usage;
  const onEvent = (json) => {
    if (json.usage) usage = json.usage;
    if (json.x_groq?.usage) usage = json.x_groq.usage;
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
    /** Token usage the provider reported in the stream, if any. */
    usage: () => usage,
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
      // and /openrouter/v1/... to OpenRouter.
      // /ollama/v1/... goes to the local Ollama, only so its requests are measured the same way.
      const route = /^\/(groq|openrouter|ollama|mistral)\//.exec(req.url ?? '')?.[1];
      let attached = 0;
      let missing = 0;
      if (route) attached = stripReasoning(bodyObj);
      else [attached, missing] = attachSignatures(bodyObj);
      // Ask streamed responses to report token usage, so the log can show it.
      // Mistral rejects unknown request fields and reports usage in streams by itself.
      if (route === 'mistral') {
        if (bodyObj) delete bodyObj.stream_options;
      } else if (bodyObj?.stream && !bodyObj.stream_options) {
        bodyObj.stream_options = { include_usage: true };
      }

      // TrueForge calls <baseUrl>/chat/completions with baseUrl ending in /v1; no upstream base has it twice.
      const upstreamPath = (req.url ?? '/').replace(/^\/(groq|openrouter|ollama|mistral)(?=\/)/, '').replace(/^\/v1(?=\/|$)/, '');
      const targetBase = route ? ROUTES[route] : TARGET_BASE;
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

      // Streamed requests get response headers at once and a keep-alive comment every 10 s.
      // TrueForge gives up after 60 s without headers ("Headers Timeout Error"), which a slow or
      // overloaded provider exceeded mid-run; with the stream already open, waiting is safe.
      const streaming = bodyObj?.stream === true;
      let keepAlive;
      if (streaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': gemini-proxy connected\n\n');
        keepAlive = setInterval(() => {
          if (!res.writableEnded) res.write(': keep-alive\n\n');
        }, 10000);
      }
      // Stop asking the provider if TrueForge goes away (for example the run was cancelled).
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      /** Ends an already-open stream with an error event TrueForge reports as a model error. */
      const streamError = (status, text) => {
        let message = text;
        try {
          const json = JSON.parse(text);
          message = (Array.isArray(json) ? json[0] : json)?.error?.message ?? text;
        } catch {
          // plain text
        }
        res.write(`data: ${JSON.stringify({ error: { message: `${status} ${String(message).slice(0, 1500)}`, code: status } })}\n\n`);
        res.end();
      };

      try {
        const send = () =>
          fetch(`${targetBase}${upstreamPath}`, {
            method: req.method,
            headers: forwardHeaders(Object.entries(req.headers)),
            body: hasBody ? (bodyObj ? JSON.stringify(bodyObj) : rawBody) : undefined,
            signal: abort.signal,
          });
        // Ride out overloads (503, 500, per-minute 429). With an open stream there is no header
        // deadline, so waiting can be longer. A daily quota is not retried: waiting cannot fix it.
        const budget = RETRY_MS || (streaming ? 150000 : 40000);
        const started = Date.now();
        let upstream = await send();
        for (const wait of [2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000]) {
          if (![429, 500, 503].includes(upstream.status)) break;
          const peek = await upstream.clone().text();
          if (upstream.status === 429 && /per.?day|PerDay|daily/i.test(peek)) break;
          if (Date.now() - started + wait > budget) break;
          if (VERBOSE) console.log(`[gemini-proxy] ${route ?? 'gemini'} ${upstream.status}; retrying in ${wait / 1000}s`);
          await new Promise((r) => setTimeout(r, wait));
          upstream = await send();
        }
        const responseHeaders = forwardHeaders(upstream.headers.entries());
        const isStream = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
        let captured = 0;
        let usage;

        if (streaming && !(upstream.ok && isStream && upstream.body)) {
          const text = await upstream.text();
          if (VERBOSE) console.log(`[gemini-proxy] upstream error body: ${text.slice(0, 600)}`);
          streamError(upstream.status, text);
        } else if (streaming) {
          const collector = createStreamCollector();
          const decoder = new TextDecoder();
          for await (const chunk of upstream.body) {
            res.write(chunk);
            collector.push(decoder.decode(chunk, { stream: true }));
          }
          collector.push('\n');
          captured = collector.finish();
          usage = collector.usage();
          res.end();
        } else if (isStream && upstream.body) {
          res.writeHead(upstream.status, responseHeaders);
          const collector = createStreamCollector();
          const decoder = new TextDecoder();
          for await (const chunk of upstream.body) {
            res.write(chunk);
            collector.push(decoder.decode(chunk, { stream: true }));
          }
          collector.push('\n');
          captured = collector.finish();
          usage = collector.usage();
          res.end();
        } else {
          const text = await upstream.text();
          try {
            const json = JSON.parse(text);
            captured = captureFromJson(json);
            usage = json.usage;
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
            `[gemini-proxy] ${route ?? 'gemini'} ${req.method} ${upstreamPath} -> ${upstream.status}` +
              ` stream=${isStream} messages=${bodyObj?.messages?.length ?? 0}` +
              ` attached=${attached} missing=${missing} captured=${captured}` +
              ` sentTokens~${sizeOf(bodyObj)}` +
              (usage
                ? ` prompt=${usage.prompt_tokens} cached=${usage.prompt_tokens_details?.cached_tokens ?? 0} completion=${usage.completion_tokens}`
                : ''),
          );
        }
      } catch (err) {
        if (VERBOSE) console.log(`[gemini-proxy] ${req.method} ${upstreamPath} failed: ${String(err)}`);
        if (res.writableEnded) {
          // the client already went away
        } else if (streaming) {
          streamError(502, `gemini-proxy: ${String(err)}`);
        } else {
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `gemini-proxy: ${String(err)}` } }));
        }
      } finally {
        clearInterval(keepAlive);
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
