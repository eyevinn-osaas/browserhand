import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const { app, pool } = await buildServer(config, log);

  // Listen first so /healthz is live immediately; the browser pool warms up
  // in the background and /readyz flips to ready once it is up.
  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info({ port: config.port }, 'browserhand listening');

  try {
    await pool.start();
  } catch (err) {
    log.error({ err }, 'failed to start browser pool');
    await shutdown('startup-failure', app, pool, log, 1);
    return;
  }

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void shutdown(signal, app, pool, log, 0);
    });
  }
}

async function shutdown(
  reason: string,
  app: Awaited<ReturnType<typeof buildServer>>['app'],
  pool: Awaited<ReturnType<typeof buildServer>>['pool'],
  log: ReturnType<typeof createLogger>,
  code: number,
): Promise<void> {
  log.info({ reason }, 'shutting down');
  try {
    await app.close();
    await pool.stop();
  } catch (err) {
    log.error({ err }, 'error during shutdown');
  } finally {
    process.exit(code);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
