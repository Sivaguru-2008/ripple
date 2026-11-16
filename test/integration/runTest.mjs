// Integration test: runs Task A (AGENTS.md section 7) in a real VS Code Extension Development
// Host against a running TrueForge, on a fresh clone of pallets/flask at tag 3.1.3.
//
// Prerequisites:
//   1. TrueForge (separate terminal):
//        $env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'; npx @truefoundry/trueforge@0.185.1
//   2. A local clone of pallets/flask with full history (default ../forge-refs/flask,
//      override with RIPPLE_FLASK_REPO).
//   3. A Python with Flask's runtime dependencies (werkzeug, jinja2, itsdangerous, click,
//      blinker, markupsafe): RIPPLE_TEST_PYTHON, default `python`.
// Then: npm run test:vscode            (scripted mock model, no API key)
//   or: $env:RIPPLE_TEST_MODEL='ollama/qwen-coder-tools-7b'; npm run test:vscode
//
// Side effect: adds (or updates) a custom model provider "ripple-mock" in that TrueForge.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { startMockModel } from './mock-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseUrl = process.env.RIPPLE_TRUEFORGE_URL ?? 'http://localhost:8790';
const mockPort = Number(process.env.RIPPLE_MOCK_PORT ?? 8792);
const flaskRepo = process.env.RIPPLE_FLASK_REPO ?? path.resolve(root, '..', 'forge-refs', 'flask');

async function main() {
  try {
    await fetch(baseUrl);
  } catch {
    throw new Error(`TrueForge is not reachable at ${baseUrl}; start it first (see header of this file)`);
  }

  // RIPPLE_TEST_MODEL names a model already configured in TrueForge (provider/model).
  // Without it, the scripted mock is started and registered.
  const realModel = process.env.RIPPLE_TEST_MODEL;
  let mock;
  if (!realModel) {
    mock = await startMockModel(mockPort);
    const tf = new TrueForge({ baseUrl });
    await tf.settings.modelProviders.createOrUpdate({
      manifest: {
        type: 'custom',
        name: 'ripple-mock',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        auth: { apiKey: 'unused' },
        models: [{ name: 'mock-1', modelId: 'mock-1', properties: { contextLength: 32000, maxOutputTokens: 1000 } }],
      },
    });
  }
  const model = realModel ?? 'ripple-mock/mock-1';
  console.log(`Model: ${model}`);

  const tmp = mkdtempSync(path.join(tmpdir(), 'ripple-it-'));
  const inline = JSON.parse(readFileSync(path.join(root, 'agents', 'ripple-inline.json'), 'utf-8'));
  inline.model = { ...inline.model, name: model };
  const inlinePath = path.join(tmp, 'ripple-inline.json');
  writeFileSync(inlinePath, JSON.stringify(inline, null, 2));

  // Fresh clone at the pinned tag, so `git status` reflects only what this test does.
  const workspace = path.join(tmp, 'flask');
  execFileSync('git', ['clone', '--quiet', flaskRepo, workspace], { stdio: 'inherit' });
  execFileSync('git', ['-C', workspace, 'checkout', '--quiet', '3.1.3'], { stdio: 'inherit' });

  // Settings go in the user profile, not the workspace, to keep the clone untouched.
  const userData = path.join(tmp, 'user-data');
  mkdirSync(path.join(userData, 'User'), { recursive: true });
  writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({ 'ripple.trueforgeBaseUrl': baseUrl, 'ripple.warmUp': Boolean(realModel), 'git.enabled': false }),
  );

  await esbuild.build({
    // RIPPLE_TEST_SUITE: run another suite file (e.g. a copy of the committed one).
    entryPoints: [process.env.RIPPLE_TEST_SUITE ?? path.join(root, 'test', 'integration', 'suite.ts')],
    bundle: true,
    outfile: path.join(root, 'dist', 'test', 'suite.js'),
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    logLevel: 'warning',
  });

  // Inherited from a parent Electron app (e.g. a terminal inside another Electron host),
  // this makes VS Code's extension host attach to the wrong crash handler and never start.
  delete process.env.CHROME_CRASHPAD_PIPE_NAME;

  const installed = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE ?? (existsSync(installed) ? installed : undefined);

  try {
    await runTests({
      ...(vscodeExecutablePath ? { vscodeExecutablePath } : {}),
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, 'dist', 'test', 'suite.js'),
      extensionTestsEnv: {
        RIPPLE_TEST_INLINE_AGENT: inlinePath,
        RIPPLE_TEST_PYTHON: process.env.RIPPLE_TEST_PYTHON ?? 'python',
        RIPPLE_TEST_MOCK: realModel ? '' : '1',
      },
      launchArgs: [workspace, '--disable-extensions', '--user-data-dir', userData, '--skip-welcome'],
    });
    console.log('Integration test passed.');
  } finally {
    mock?.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
