// Records the Forge-a-thon demo: a fresh flask 3.1.3 clone, the real VS Code with Ripple, the demo
// driver (scripts/demo/demoSuite.ts) performing Tasks A, B and C, and a full-screen capture with
// ffmpeg. Then scripts/demo/make-video.mjs edits it into the final video.
//
//   npm run demo:record              real models from agents/*.json (needs npm run stack, Ollama)
//   npm run demo:record -- --mock    the scripted mock model: checks the pipeline, costs no quota
//
// Needs VSCODE_EXECUTABLE and RIPPLE_TEST_PYTHON (as for npm run task-b) and ffmpeg on PATH.
// Do not use the computer while it records: the capture is the whole screen.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const mock = args.includes('--mock');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.resolve(args[args.indexOf('--out') + 1] && args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(root, 'demo-out', `${stamp}${mock ? '-mock' : ''}`));
const baseUrl = process.env.RIPPLE_TRUEFORGE_URL ?? 'http://localhost:8790';
const flaskRepo = process.env.RIPPLE_FLASK_REPO ?? path.resolve(root, '..', 'forge-refs', 'flask');
const python = process.env.RIPPLE_TEST_PYTHON;

async function up(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).status < 500;
  } catch {
    return false;
  }
}

function pythonEnv() {
  if (!python || !path.isAbsolute(python)) return { PYTHONPATH: 'src' };
  const dir = path.dirname(python);
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { PYTHONPATH: 'src', [key]: [dir, path.join(dir, 'Scripts'), process.env[key] ?? ''].join(path.delimiter) };
}

function startAdapter() {
  // Output goes straight to a file (not a pipe), so this script can exit while the adapter runs on.
  const fd = openSync(path.join(out, 'adapter.log'), 'a');
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'gemini-proxy.mjs')], { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
}

async function main() {
  mkdirSync(out, { recursive: true });
  console.log(`Output: ${out}`);
  if (!(await up(`${baseUrl}/api/v1/settings/model-providers`))) throw new Error(`TrueForge is not reachable at ${baseUrl}; run npm run stack first`);
  if (!python) throw new Error('set RIPPLE_TEST_PYTHON to a Python with pytest and Flask\'s dependencies');

  const inline = JSON.parse(readFileSync(path.join(root, 'agents', 'ripple-inline.json'), 'utf-8'));
  const agent = JSON.parse(readFileSync(path.join(root, 'agents', 'ripple-agent.json'), 'utf-8'));
  let mockServer;
  if (mock) {
    const { startMockModel } = await import('../../test/integration/mock-model.mjs');
    mockServer = await startMockModel(8792);
    await new TrueForge({ baseUrl }).settings.modelProviders.createOrUpdate({
      manifest: {
        type: 'custom',
        name: 'ripple-mock',
        baseUrl: 'http://127.0.0.1:8792/v1',
        auth: { apiKey: 'unused' },
        models: [{ name: 'mock-1', modelId: 'mock-1', properties: { contextLength: 32000, maxOutputTokens: 1000 } }],
      },
    });
    inline.model = { ...inline.model, name: 'ripple-mock/mock-1' };
    agent.model = { ...agent.model, name: 'ripple-mock/mock-1' };
  } else {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'setup-models.mjs')], { stdio: 'inherit' });
  }
  if (!(await up('http://127.0.0.1:8794/health'))) startAdapter();
  console.log(`Models: inline ${inline.model.name}, agent ${agent.model.name}, fallback ollama/qwen-coder-tools-7b`);
  const inlinePath = path.join(out, 'ripple-inline.json');
  const agentPath = path.join(out, 'ripple-agent.json');
  writeFileSync(inlinePath, JSON.stringify(inline, null, 2));
  writeFileSync(agentPath, JSON.stringify(agent, null, 2));

  const workspace = path.join(out, 'flask');
  execFileSync('git', ['clone', '--quiet', flaskRepo, workspace], { stdio: 'inherit' });
  execFileSync('git', ['-C', workspace, 'checkout', '--quiet', '3.1.3'], { stdio: 'ignore' });

  const userData = path.join(out, 'user-data');
  mkdirSync(path.join(userData, 'User'), { recursive: true });
  writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify(
      {
        'ripple.trueforgeBaseUrl': baseUrl,
        'ripple.warmUp': false,
        'ripple.fallbackModel': 'ollama/qwen-coder-tools-7b',
        'git.enabled': false,
        'window.newWindowDimensions': 'maximized',
        'workbench.startupEditor': 'none',
        'workbench.tips.enabled': false,
        'workbench.colorTheme': 'Default Dark Modern',
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'chat.disableAIFeatures': true,
        'chat.commandCenter.enabled': false,
        'window.commandCenter': false,
        'editor.minimap.enabled': false,
        'editor.fontSize': 17,
        'editor.codeLens': true,
        'terminal.integrated.fontSize': 16,
        'terminal.integrated.defaultProfile.windows': 'PowerShell',
        'security.workspace.trust.enabled': false,
        'update.mode': 'none',
        'telemetry.telemetryLevel': 'off',
      },
      null,
      2,
    ),
  );

  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore', shell: true });
  const suite = path.join(root, 'dist', 'test', 'demoSuite.js');
  await esbuild.build({ entryPoints: [path.join(root, 'scripts', 'demo', 'demoSuite.ts')], bundle: true, outfile: suite, platform: 'node', format: 'cjs', external: ['vscode'], logLevel: 'warning' });

  // Only the demo window may be on screen: minimize everything else first, then keep the demo
  // VS Code window maximized in front for the whole recording.
  const windowTool = (action, match = '') =>
    new Promise((resolve) => {
      const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'demo', 'window.ps1'), '-Action', action, ...(match ? ['-Match', match] : [])], { stdio: ['ignore', 'pipe', 'ignore'] });
      let text = '';
      p.stdout.on('data', (d) => (text += d));
      p.on('exit', () => resolve(text.trim()));
    });
  const taskbar = Number(await windowTool('taskbar')) || 0;
  await windowTool('minimize-all');
  let keepFront = true;
  const keeper = (async () => {
    while (keepFront) {
      const r = await windowTool('front', userData);
      if (r === 'moved to front') console.log('[window] demo window brought to the front');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  })();

  // Full-screen capture. It starts before VS Code opens and stops after the driver ends.
  const raw = path.join(out, 'raw.mp4');
  const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-y', '-f', 'gdigrab', '-framerate', '30', '-i', 'desktop', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', raw], { stdio: ['pipe', 'ignore', 'pipe'] });
  const t0 = await new Promise((resolve, reject) => {
    ffmpeg.stderr.on('data', function onData(chunk) {
      if (String(chunk).includes('frame=')) {
        ffmpeg.stderr.off('data', onData);
        resolve(Date.now());
      }
    });
    ffmpeg.on('exit', (code) => reject(new Error(`ffmpeg exited early with code ${code}`)));
  });
  // The taskbar (pinned apps, system tray) is cropped out of the video.
  writeFileSync(path.join(out, 'recording.json'), JSON.stringify({ t0, cropBottom: taskbar }));
  console.log('Recording. Do not use the computer until it says it has stopped.');

  delete process.env.CHROME_CRASHPAD_PIPE_NAME;
  delete process.env.ELECTRON_RUN_AS_NODE;
  let failure;
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE,
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      // An empty extensions folder keeps the user's extensions out but leaves VS Code's built-in
      // ones (Simple Browser shows the TrueForge session inside the window).
      launchArgs: [workspace, '--user-data-dir', userData, '--extensions-dir', path.join(out, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
      extensionTestsEnv: {
        ...process.env,
        ...pythonEnv(),
        RIPPLE_TEST_INLINE_AGENT: inlinePath,
        RIPPLE_TEST_AGENT: agentPath,
        RIPPLE_DEMO_TIMELINE: path.join(out, 'timeline.json'),
        RIPPLE_TRUEFORGE_URL: baseUrl,
      },
    });
  } catch (err) {
    failure = err;
  } finally {
    ffmpeg.stdin.write('q');
    await new Promise((resolve) => ffmpeg.on('exit', resolve));
    keepFront = false;
    await keeper;
    await windowTool('restore-all');
    mockServer?.close();
    console.log('Recording stopped.');
  }
  // Task C stops the model adapter on purpose; bring it back.
  if (!(await up('http://127.0.0.1:8794/health'))) startAdapter();
  if (failure) throw failure;

  if (!args.includes('--no-edit')) {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'demo', 'make-video.mjs'), out], { stdio: 'inherit' });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
