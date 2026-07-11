import { z } from 'zod';

/**
 * browserhand configuration. All settings come from environment variables so the
 * service is a clean fit for containerized / OSC deployment. This schema is the
 * single source of truth — keep .env.example, the README config table, and the
 * OSC submission variable list in sync with it.
 */
const ConfigSchema = z.object({
  /** HTTP port. The server always binds 0.0.0.0. */
  port: z.coerce.number().int().positive().default(8080),
  /** Optional bearer token. When set, every /v1 request must present it. */
  apiKey: z.string().min(1).optional(),
  /** Hard cap on simultaneously open browser sessions. */
  maxConcurrentSessions: z.coerce.number().int().positive().default(5),
  /** Idle timeout (ms) after which a session is auto-closed. */
  sessionTimeoutMs: z.coerce.number().int().positive().default(300_000),
  /** pino log level. */
  logLevel: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
  /** Internal Chromium remote-debugging port backing the CDP WebSocket proxy. */
  cdpPort: z.coerce.number().int().positive().default(9223),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    port: env.PORT,
    apiKey: env.BROWSERHAND_API_KEY || undefined,
    maxConcurrentSessions: env.MAX_CONCURRENT_SESSIONS,
    sessionTimeoutMs: env.SESSION_TIMEOUT_MS,
    logLevel: env.LOG_LEVEL,
    cdpPort: env.CDP_PORT,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid browserhand configuration:\n${issues}`);
  }
  return parsed.data;
}
