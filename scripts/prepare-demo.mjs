// Prepares the Task A/B/C demo workspace so the agent's own commands behave like a developer's:
//   1. a clone of pallets/flask at tag 3.1.3 next to this repository (../flask-demo), from a local
//      clone if RIPPLE_FLASK_REPO points at one, otherwise from GitHub;
//   2. a Python that has pytest and Flask's dependencies (checked, nothing is installed);
//   3. .env.demo (git-ignored) with PATH and PYTHONPATH for the "Run Ripple on the Flask demo"
//      launch configuration, so `python -m pytest` in run_command imports the clone's own Flask.
// Without this, `python` may be a Python without pytest, and models then try `pip install`.
//
//   npm run demo:prepare            (RIPPLE_TEST_PYTHON=<python.exe> to choose the Python)
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(root, '..', 'flask-demo');
const TAG = '3.1.3';
const COMMIT = '22d92470';
const MODULES = 'import pytest, werkzeug, jinja2, click, itsdangerous, blinker, markupsafe';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function findPython() {
  const candidates = [];
  if (process.env.RIPPLE_TEST_PYTHON) candidates.push([process.env.RIPPLE_TEST_PYTHON, []]);
  if (process.platform === 'win32') for (const v of ['3.12', '3.13', '3.11', '3.14']) candidates.push(['py', [`-${v}`]]);
  candidates.push(['python3', []], ['python', []]);
  for (const [cmd, pre] of candidates) {
    try {
      run(cmd, [...pre, '-c', MODULES]);
      return run(cmd, [...pre, '-c', 'import sys; print(sys.executable)']);
    } catch {
      // not usable; try the next
    }
  }
  return undefined;
}

function main() {
  if (!existsSync(path.join(target, '.git'))) {
    const local = process.env.RIPPLE_FLASK_REPO ?? path.resolve(root, '..', 'forge-refs', 'flask');
    const source = existsSync(path.join(local, '.git')) ? local : 'https://github.com/pallets/flask';
    console.log(`Cloning ${source} into ${target} (full history, for co-change retrieval)...`);
    execFileSync('git', ['clone', '--quiet', source, target], { stdio: 'inherit' });
  }
  execFileSync('git', ['-C', target, 'checkout', '--quiet', TAG], { stdio: 'inherit' });
  const head = run('git', ['-C', target, 'rev-parse', '--short=8', 'HEAD']);
  if (head !== COMMIT) throw new Error(`${target} is at ${head}, expected ${COMMIT} (tag ${TAG})`);
  const dirty = run('git', ['-C', target, 'status', '--porcelain']);
  console.log(`Flask clone: ${target} at ${TAG} (${head}), ${dirty ? 'HAS LOCAL CHANGES:\n' + dirty : 'clean'}`);

  const python = findPython();
  if (!python) {
    throw new Error(
      `No Python with pytest and Flask's dependencies found. Install them in a Python of your choice ` +
        `(python -m pip install pytest werkzeug jinja2 click itsdangerous blinker) and rerun with RIPPLE_TEST_PYTHON=<python>.`,
    );
  }
  const dir = path.dirname(python);
  const scripts = path.join(dir, process.platform === 'win32' ? 'Scripts' : '');
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const envFile = path.join(root, '.env.demo');
  writeFileSync(
    envFile,
    [
      '# Written by scripts/prepare-demo.mjs for the "Run Ripple on the Flask demo" launch configuration.',
      '# The agent\'s commands run in the Flask clone; PYTHONPATH=src makes them import its own Flask.',
      `PYTHONPATH=src`,
      `${pathKey}=${[dir, scripts, process.env[pathKey] ?? ''].join(path.delimiter)}`,
      '',
    ].join('\n'),
  );
  console.log(`Python for the agent's commands: ${python}`);
  console.log(`Wrote ${path.relative(root, envFile)}. In VS Code, run the launch configuration "Run Ripple on the Flask demo".`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
