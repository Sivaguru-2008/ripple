// Inline-edit checks in a real VS Code host on a fresh flask 3.1.3 clone (AGENTS.md section 7):
//   npm run task-c   Task C: registers a TrueForge provider whose endpoint is unreachable
//                    (127.0.0.1:9), makes it the inline agent's model and repeats Task A; Ripple
//                    must fall back to ripple.fallbackModel on its own. Side effect: adds (or
//                    updates) a provider "unreachable" in that TrueForge.
//   npm run task-a   Task A on the inline agent's own model (RIPPLE_TEST_MODEL to override);
//                    the primary must finish without a fallback.
// Both need VSCODE_EXECUTABLE and RIPPLE_TEST_PYTHON as for task-b; RIPPLE_FALLBACK_MODEL
// (default ollama/qwen-coder-tools-7b) is the fallback.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseUrl = process.env.RIPPLE_TRUEFORGE_URL ?? 'http://localhost:8790';
const flaskRepo = process.env.RIPPLE_FLASK_REPO ?? path.resolve(root, '..', 'forge-refs', 'flask');
const fallback = process.env.RIPPLE_FALLBACK_MODEL ?? 'ollama/qwen-coder-tools-7b';
const DEAD = 'unreachable/dead-endpoint';

const task = (process.argv[2] ?? 'C').toUpperCase();

async function main() {
  const inline = JSON.parse(readFileSync(path.join(root, 'agents', 'ripple-inline.json'), 'utf-8'));
  if (task === 'A') {
    const model = process.env.RIPPLE_TEST_MODEL ?? inline.model.name;
    inline.model = { ...inline.model, name: model };
    console.log(`Task A on ${model}; fallback if it fails: ${fallback} (a fallback fails the check)`);
  } else {
    await registerUnreachable();
    inline.model = { ...inline.model, name: DEAD };
    console.log(`Inline agent model: ${DEAD} (unreachable endpoint); fallback: ${fallback}`);
  }
  await runCheck(inline);
}

async function registerUnreachable() {
  const tf = new TrueForge({ baseUrl });
  await tf.settings.modelProviders.createOrUpdate({
    manifest: {
      type: 'custom',
      name: 'unreachable',
      // Port 9 (discard) has nothing listening: every request fails to connect.
      baseUrl: 'http://127.0.0.1:9/v1',
      auth: { apiKey: 'unused' },
      models: [{ name: 'dead-endpoint', modelId: 'dead', properties: { contextLength: 32000, maxOutputTokens: 4096 } }],
    },
  });
}

async function runCheck(inline) {
  const tmp = mkdtempSync(path.join(realpathSync.native(tmpdir()), `ripple-${task.toLowerCase()}-`));
  const inlinePath = path.join(tmp, 'ripple-inline.json');
  writeFileSync(inlinePath, JSON.stringify(inline, null, 2));

  const workspace = path.join(tmp, 'flask');
  execFileSync('git', ['clone', '--quiet', flaskRepo, workspace], { stdio: 'inherit' });
  execFileSync('git', ['-C', workspace, 'checkout', '--quiet', '3.1.3'], { stdio: 'ignore' });

  const userData = path.join(tmp, 'user-data');
  mkdirSync(path.join(userData, 'User'), { recursive: true });
  writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({ 'ripple.trueforgeBaseUrl': baseUrl, 'ripple.warmUp': false, 'ripple.fallbackModel': fallback, 'git.enabled': false }),
  );

  const bundleOut = path.join(root, 'dist', 'test', 'taskCSuite.js');
  await esbuild.build({
    entryPoints: [path.join(root, 'test', 'integration', 'taskCSuite.ts')],
    bundle: true,
    outfile: bundleOut,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    logLevel: 'warning',
  });

  delete process.env.CHROME_CRASHPAD_PIPE_NAME;
  delete process.env.ELECTRON_RUN_AS_NODE;
  const outReportPath = path.join(tmp, 'report-c.json');
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE,
    extensionDevelopmentPath: root,
    extensionTestsPath: bundleOut,
    launchArgs: [workspace, '--user-data-dir', userData, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: {
      ...process.env,
      RIPPLE_TEST_INLINE_AGENT: inlinePath,
      RIPPLE_RUN_OUT: outReportPath,
      RIPPLE_EXPECT_FALLBACK: task === 'A' ? '0' : '1',
    },
  });
  if (existsSync(outReportPath)) console.log(`Report: ${outReportPath}\n${readFileSync(outReportPath, 'utf-8')}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
