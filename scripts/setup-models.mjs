// Registers the model providers in config/trueforge.models.json (or the committed example) in a
// running TrueForge. Keys come from the environment or the git-ignored .env file, never from this
// repository; a provider whose key is missing is skipped. Safe to run again: it updates in place.
//
//   npm run models            (TrueForge must be running; RIPPLE_TRUEFORGE_URL to override)
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.RIPPLE_TRUEFORGE_URL ?? 'http://localhost:8790';

/** KEY=value lines of .env, without overriding variables already set. */
function loadDotEnv() {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/** Replaces "${NAME}" with the variable's value; returns the names that were missing. */
function substitute(value, missing) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      const v = process.env[name];
      if (!v) missing.add(name);
      return v ?? '';
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, missing));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, missing)]));
  }
  return value;
}

async function main() {
  loadDotEnv();
  const local = path.join(root, 'config', 'trueforge.models.json');
  const configFile = existsSync(local) ? local : path.join(root, 'config', 'trueforge.models.example.json');
  const { providers } = JSON.parse(readFileSync(configFile, 'utf-8'));
  console.log(`Providers from ${path.relative(root, configFile)} -> TrueForge at ${baseUrl}`);

  const tf = new TrueForge({ baseUrl });
  try {
    await tf.settings.modelProviders.list();
  } catch (err) {
    throw new Error(`TrueForge is not reachable at ${baseUrl} (${err instanceof Error ? err.message : err}); start it first (npm run stack)`);
  }

  let registered = 0;
  for (const provider of providers) {
    const missing = new Set();
    const manifest = substitute(provider, missing);
    if (missing.size) {
      console.log(`  skipped ${provider.name}: set ${[...missing].join(', ')} in .env`);
      continue;
    }
    await tf.settings.modelProviders.createOrUpdate({ manifest });
    registered++;
    console.log(`  ${provider.name}: ${manifest.models.map((m) => `${provider.name}/${m.name}`).join(', ')}`);
  }
  console.log(`${registered} provider(s) registered. Use a model as "<provider>/<name>" in agents/*.json or ripple.fallbackModel.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
