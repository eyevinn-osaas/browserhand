/**
 * Generate openapi.json from the live route schemas and commit it to the repo.
 * The committed spec's URL is what you hand to OSC during submission (manual step)
 * and what an MCP layer can consume to auto-generate tools.
 *
 * Run: npm run openapi
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { buildServer } from '../src/server.js';

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'openapi.json');

async function main(): Promise<void> {
  const config = loadConfig({ ...process.env, LOG_LEVEL: 'silent' });
  const log = createLogger('silent');
  const { app } = await buildServer(config, log);
  await app.ready(); // finalizes route registration so the spec is complete
  const spec = app.swagger();
  writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');
  await app.close();
  // eslint-disable-next-line no-console
  console.log(`Wrote ${outPath} (${Object.keys((spec as { paths?: object }).paths ?? {}).length} paths)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
