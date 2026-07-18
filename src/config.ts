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

/**
 * Some orchestrators (including OSC) inject an empty string for an optional env
 * var that was left unset, rather than omitting it. zod's `.default()` only
 * applies to `undefined` — an empty string passes through and (for numbers) gets
 * coerced to 0, silently defeating validators like `.positive()`. Normalize
 * empty strings to `undefined` here, once, so every field's `.default()` applies
 * the same way regardless of how the value was omitted.
 */
function emptyToUndefined(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    port: emptyToUndefined(env.PORT),
    apiKey: emptyToUndefined(env.BROWSERHAND_API_KEY),
    maxConcurrentSessions: emptyToUndefined(env.MAX_CONCURRENT_SESSIONS),
    sessionTimeoutMs: emptyToUndefined(env.SESSION_TIMEOUT_MS),
    logLevel: emptyToUndefined(env.LOG_LEVEL),
    cdpPort: emptyToUndefined(env.CDP_PORT),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid browserhand configuration:\n${issues}`);
  }
  return parsed.data;
}
