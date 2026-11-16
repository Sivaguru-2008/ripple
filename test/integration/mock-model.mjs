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

/** Task B edits across 3 files. */
const TASK_B_CLI_OLD = `        if add_default_commands:
            self.add_command(run_command)
            self.add_command(shell_command)
            self.add_command(routes_command)`;

const TASK_B_CLI_NEW = `        if add_default_commands:
            self.add_command(run_command)
            self.add_command(shell_command)
            self.add_command(routes_command)
            self.add_command(config_command)`;

const TASK_B_CLI_DEF_OLD = `cli = FlaskGroup(
    name="flask",`;

const TASK_B_CLI_DEF_NEW = `@click.command("config", short_help="Show loaded configuration as JSON.")
@with_appcontext
def config_command() -> None:
    """Show loaded application configuration as JSON, masking sensitive values."""
    import json
    mask_keys = {"SECRET", "PASSWORD", "TOKEN", "KEY"}
    def mask_val(v):
        try:
            json.dumps(v)
            return v
        except (TypeError, OverflowError):
            return repr(v)
    masked = {
        k: "***" if any(m in k.upper() for m in mask_keys) else mask_val(v)
        for k, v in current_app.config.items()
    }
    click.echo(json.dumps(masked, indent=2, sort_keys=True))


cli = FlaskGroup(
    name="flask",`;

const TASK_B_TEST_OLD = `def test_run_exclude_patterns():
    ctx = run_command.make_context("run", ["--exclude-patterns", __file__])
    assert ctx.params["exclude_patterns"] == [__file__]`;

const TASK_B_TEST_NEW = `def test_run_exclude_patterns():
    ctx = run_command.make_context("run", ["--exclude-patterns", __file__])
    assert ctx.params["exclude_patterns"] == [__file__]


def test_config_command(runner):
    app = Flask("test_config")
    app.config["SECRET_KEY"] = "super-secret"
    app.config["MY_PASSWORD"] = "p4ss"
    app.config["API_TOKEN"] = "tok"
    app.config["SOME_KEY"] = "val"
    app.config["NORMAL_VAR"] = "visible"

    test_cli = FlaskGroup(create_app=lambda: app)
    result = runner.invoke(test_cli, ["config"])
    assert result.exit_code == 0
    assert '"SECRET_KEY": "***"' in result.output
    assert '"MY_PASSWORD": "***"' in result.output
    assert '"API_TOKEN": "***"' in result.output
    assert '"SOME_KEY": "***"' in result.output
    assert '"NORMAL_VAR": "visible"' in result.output
    assert "super-secret" not in result.output`;

const TASK_B_DOC_OLD = `Open a Shell
------------`;

const TASK_B_DOC_NEW = 'Show Configuration\n' +
  '------------------\n\n' +
  'To print the loaded application configuration as JSON, run the ``flask config`` command.\n' +
  'Sensitive keys containing SECRET, PASSWORD, TOKEN, or KEY are automatically masked. ::\n\n' +
  '    $ flask config\n' +
  '    {\n' +
  '      "DEBUG": false,\n' +
  '      "SECRET_KEY": "***",\n' +
  '      "TESTING": false\n' +
  '    }\n\n\n' +
  'Open a Shell\n' +
  '------------';

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

  // Task B agent mode:
  const isTaskB = user.includes('flask config') || messages.some((m) => String(m.content).includes('flask config'));
  if (isTaskB) {
    if (!called.some((n) => n.endsWith('retrieve_context'))) {
      return { tool: pick('retrieve_context'), args: { task: user } };
    }
    const writeCount = called.filter((n) => n.endsWith('propose_write')).length;
    if (writeCount === 0) {
      return {
        tool: pick('propose_write'),
        args: {
          path: 'src/flask/cli.py',
          edits: [
            { old_text: TASK_B_CLI_OLD, new_text: TASK_B_CLI_NEW },
            { old_text: TASK_B_CLI_DEF_OLD, new_text: TASK_B_CLI_DEF_NEW },
          ],
        },
      };
    }
    if (writeCount === 1) {
      return {
        tool: pick('propose_write'),
        args: {
          path: 'tests/test_cli.py',
          edits: [{ old_text: TASK_B_TEST_OLD, new_text: TASK_B_TEST_NEW }],
        },
      };
    }
    if (writeCount === 2) {
      return {
        tool: pick('propose_write'),
        args: {
          path: 'docs/cli.rst',
          edits: [{ old_text: TASK_B_DOC_OLD, new_text: TASK_B_DOC_NEW }],
        },
      };
    }
    if (!called.some((n) => n.endsWith('run_command') || n.endsWith('call_tool'))) {
      // The whole test file, against the clone's own sources (PYTHONPATH=src).
      const python = `"${process.env.RIPPLE_TEST_PYTHON ?? 'python'}" -m pytest tests/test_cli.py -q`;
      const command = process.platform === 'win32' ? `set "PYTHONPATH=src" && ${python}` : `PYTHONPATH=src ${python}`;
      // run_command is a deferred tool: unless it was preloaded, it is reached through call_tool.
      const direct = names.find((n) => n?.endsWith('run_command'));
      if (direct) return { tool: direct, args: { command } };
      return { tool: pick('call_tool'), args: { mcp_server: 'ripple', tool_name: 'run_command', input: { command } } };
    }
    return { text: `Task B complete. Added flask config CLI command, test in tests/test_cli.py, and documentation in docs/cli.rst. Tests verified.` };
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
