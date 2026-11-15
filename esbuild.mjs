// Bundles the extension into dist/extension.js (CommonJS, as VS Code expects).
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode'],
  // The TrueForge SDK's CJS build cannot be required by Node; prefer ESM builds.
  conditions: ['import', 'module', 'default'],
  mainFields: ['module', 'main'],
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
