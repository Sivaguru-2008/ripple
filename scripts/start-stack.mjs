// Starts everything Ripple's agent needs, in one terminal, on Windows, macOS or Linux:
//   1. TrueForge in local mode (pinned version, localhost allowed for the MCP server),
//   2. the model adapter (scripts/gemini-proxy.mjs) on 127.0.0.1:8794,
//   3. then registers the model providers (scripts/setup-models.mjs) from .env.
// A part that is already running is reused. Ctrl+C stops what this script started.
//
//   npm run stack
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRUEFORGE = '@truefoundry/trueforge@0.185.1';
const trueforgeUrl = process.env.RIPPLE_TRUEFORGE_URL ?? 'http://localhost:8790';
const adapterUrl = 'http://127.0.0.1:8794/health';
const children = [];

async function up(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitFor(name, url, seconds) {
  for (let k = 0; k < seconds; k++) {
    if (await up(url)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} did not come up at ${url} within ${seconds} s`);
}

function start(name, command, args, extraEnv = {}) {
  // npx is a .cmd file on Windows and needs a shell; then the command goes as one fixed string.
  const viaShell = command === 'npx';
  const options = { cwd: root, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] };
  const child = viaShell ? spawn([command, ...args].join(' '), { ...options, shell: true }) : spawn(command, args, options);
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/sandbox-environments\/pending| info request \{/.test(l))
      .forEach((l) => console.log(`[${name}] ${l}`));
  child.stdout.on('data', prefix);
  child.stderr.on('data', prefix);
  child.on('exit', (code) => console.log(`[${name}] exited with code ${code}`));
  children.push(child);
  return child;
}

function stopAll() {
  for (const c of children) if (!c.killed) c.kill();
}
process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});

async function main() {
  if (await up(`${trueforgeUrl}/api/v1/settings/model-providers`)) {
    console.log(`TrueForge already running at ${trueforgeUrl}`);
  } else {
    console.log(`Starting TrueForge (${TRUEFORGE})...`);
    // The MCP server runs on 127.0.0.1; TrueForge blocks local addresses unless allowed.
    start('trueforge', 'npx', ['--yes', TRUEFORGE], { OUTBOUND_URL_ALLOWED_HOSTS: '["127.0.0.1"]' });
    await waitFor('TrueForge', `${trueforgeUrl}/api/v1/settings/model-providers`, 180);
  }

  if (await up(adapterUrl)) {
    console.log('Model adapter already running on 127.0.0.1:8794');
  } else {
    console.log('Starting the model adapter...');
    start('adapter', process.execPath, [path.join(root, 'scripts', 'gemini-proxy.mjs')]);
    await waitFor('Model adapter', adapterUrl, 20);
  }

  await new Promise((resolve, reject) => {
    const setup = spawn(process.execPath, [path.join(root, 'scripts', 'setup-models.mjs')], { cwd: root, stdio: 'inherit' });
    setup.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`setup-models exited with code ${code}`))));
  });

  console.log(`\nReady. TrueForge UI: ${trueforgeUrl}  (sessions for the video are there)`);
  if (children.length) console.log('Leave this terminal open; Ctrl+C stops what it started.');
  else process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  stopAll();
  process.exit(1);
});
