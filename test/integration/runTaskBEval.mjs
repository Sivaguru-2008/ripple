// Driver script to run Task B validation across 5 independent fresh clones using a real model.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseUrl = process.env.RIPPLE_TRUEFORGE_URL ?? 'http://localhost:8790';
const flaskRepo = process.env.RIPPLE_FLASK_REPO ?? path.resolve(root, '..', 'forge-refs', 'flask');
const model = process.env.RIPPLE_TEST_MODEL ?? 'gemini/gemini-3-1-flash-lite';
const totalRuns = Number(process.env.RIPPLE_RUNS ?? 5);

/** PATH and PYTHONPATH for the agent's commands, from RIPPLE_TEST_PYTHON. */
function testPythonEnv() {
  const py = process.env.RIPPLE_TEST_PYTHON;
  if (!py || !path.isAbsolute(py)) return { PYTHONPATH: 'src' };
  const dir = path.dirname(py);
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return {
    PYTHONPATH: 'src',
    [pathKey]: [dir, path.join(dir, 'Scripts'), process.env[pathKey] ?? ''].join(path.delimiter),
  };
}

async function runSingle(runIndex) {
  console.log(`\n======================================================`);
  console.log(` Starting Task B Run ${runIndex} of ${totalRuns} on fresh clone `);
  console.log(` Model: ${model}`);
  console.log(`======================================================\n`);

  const tmp = mkdtempSync(path.join(realpathSync.native(tmpdir()), `ripple-b-${runIndex}-`));
  const agent = JSON.parse(readFileSync(path.join(root, 'agents', 'ripple-agent.json'), 'utf-8'));
  agent.model = { ...agent.model, name: model };
  // Test-only: a lower compaction threshold, to see TrueForge compact on a short run.
  const compactAt = Number(process.env.RIPPLE_TEST_COMPACTION_TOKENS ?? 0);
  if (compactAt > 0) {
    agent.config.context_management.compaction = { enabled: true, trigger: { type: 'input_tokens', value: compactAt } };
    console.log(`Compaction threshold for this run: ${compactAt} input tokens`);
  }
  const agentPath = path.join(tmp, 'ripple-agent.json');
  writeFileSync(agentPath, JSON.stringify(agent, null, 2));

  const workspace = path.join(tmp, 'flask');
  execFileSync('git', ['clone', '--quiet', flaskRepo, workspace], { stdio: 'inherit' });
  execFileSync('git', ['-C', workspace, 'checkout', '--quiet', '3.1.3'], { stdio: 'inherit' });

  const userData = path.join(tmp, 'user-data');
  mkdirSync(path.join(userData, 'User'), { recursive: true });
  writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'ripple.trueforgeBaseUrl': baseUrl,
      'ripple.warmUp': false,
      // A second model with its own free quota, so one provider's overload does not end the run.
      'ripple.fallbackModel': process.env.RIPPLE_FALLBACK_MODEL ?? 'gemini/gemini-3-5-flash-lite',
      'git.enabled': false,
    }),
  );

  const outReportPath = path.join(tmp, `report-${runIndex}.json`);

  delete process.env.CHROME_CRASHPAD_PIPE_NAME;
  delete process.env.ELECTRON_RUN_AS_NODE;

  const suitePath = path.join(root, 'test', 'integration', 'taskBSuite.ts');
  const bundleOut = path.join(root, 'dist', 'test', 'taskBSuite.js');

  await esbuild.build({
    entryPoints: [suitePath],
    bundle: true,
    outfile: bundleOut,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    logLevel: 'warning',
  });

  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE,
      extensionDevelopmentPath: root,
      extensionTestsPath: bundleOut,
      launchArgs: [
        workspace,
        '--user-data-dir',
        userData,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: {
        ...process.env,
        // What a developer's activated virtualenv gives: the agent's own `pytest` / `python`
        // resolve to the test Python and import the clone's Flask (commands run in the clone's root).
        // Without it a real model saw an ImportError and tried `pip install -e .`.
        ...testPythonEnv(),
        RIPPLE_TEST_AGENT: agentPath,
        RIPPLE_TEST_MODEL: model,
        RIPPLE_RUN_INDEX: String(runIndex),
        RIPPLE_RUN_OUT: outReportPath,
      },
    });

    if (existsSync(outReportPath)) {
      const data = JSON.parse(readFileSync(outReportPath, 'utf-8'));
      return data;
    }
    return { runIndex, success: true };
  } catch (err) {
    console.error(`Run ${runIndex} failed with error:`, err);
    // A run that passed every check on the fallback model writes its report before failing.
    const partial = existsSync(outReportPath) ? JSON.parse(readFileSync(outReportPath, 'utf-8')) : {};
    return {
      runIndex,
      model,
      ...partial,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const reports = [];
  for (let i = 1; i <= totalRuns; i++) {
    const report = await runSingle(i);
    reports.push(report);
  }

  console.log('\n======================================================');
  console.log('             TASK B 5-RUN SUMMARY TABLE               ');
  console.log('======================================================');
  console.table(
    reports.map((r) => ({
      Run: r.runIndex,
      Model: r.model ?? model,
      'Finished on': r.fallback ? `${r.finishedOn} (fallback)` : (r.finishedOn ?? ''),
      Status: r.success ? 'PASSED' : 'FAILED',
      Duration: r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : 'N/A',
      'Files Touched': r.touchedFiles ? r.touchedFiles.join(', ') : 'N/A',
      'Pytest Verdict': r.pytestOutput ? r.pytestOutput.slice(0, 30) : (r.error ? r.error.slice(0, 30) : 'N/A'),
    }))
  );

  const passed = reports.filter((r) => r.success).length;
  console.log(`\nTotal: ${passed}/${totalRuns} runs passed.`);

  const summaryOut = path.join(root, 'dist', 'task-b-validation-summary.json');
  mkdirSync(path.dirname(summaryOut), { recursive: true });
  writeFileSync(summaryOut, JSON.stringify(reports, null, 2), 'utf-8');
  console.log(`Detailed summary saved to: ${summaryOut}`);

  // At least 80% of the runs, e.g. 4 of 5 or 1 of 1.
  const required = Math.ceil(totalRuns * 0.8);
  if (passed < required) {
    console.error(`CRITICAL: Required at least ${required}/${totalRuns} runs to succeed, got ${passed}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error in Task B evaluation:', err);
  process.exit(1);
});
