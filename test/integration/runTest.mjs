// Integration test: runs "Ripple: Smoke Test" in a real VS Code Extension Development Host
// against a running TrueForge, with a scripted mock model so no API key is needed.
//
// Prerequisite (separate terminal):
//   $env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'; npx @truefoundry/trueforge@0.185.1
// Then: npm run test:vscode
//
// Side effect: adds (or updates) a custom model provider "ripple-mock" in that TrueForge.
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

async function main() {
  try {
    await fetch(baseUrl);
  } catch {
    throw new Error(`TrueForge is not reachable at ${baseUrl}; start it first (see header of this file)`);
  }

  const mock = await startMockModel(mockPort);
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

  const tmp = mkdtempSync(path.join(tmpdir(), 'ripple-it-'));
  const agent = JSON.parse(readFileSync(path.join(root, 'agents', 'ripple-agent.json'), 'utf-8'));
  agent.model = { name: 'ripple-mock/mock-1' };
  const agentPath = path.join(tmp, 'agent.json');
  writeFileSync(agentPath, JSON.stringify(agent, null, 2));

  const workspace = path.join(tmp, 'workspace');
  mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  writeFileSync(path.join(workspace, 'README.md'), '# Demo\nHello\n');
  writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'ripple.trueforgeBaseUrl': baseUrl }));

  await esbuild.build({
    entryPoints: [path.join(root, 'test', 'integration', 'suite.ts')],
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
      extensionTestsEnv: { RIPPLE_TEST_AGENT: agentPath },
      launchArgs: [workspace, '--disable-extensions', '--user-data-dir', path.join(tmp, 'user-data'), '--skip-welcome'],
    });
    console.log('Integration test passed.');
  } finally {
    mock.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
