import pino, { type Logger } from 'pino';

/** Create the root logger. Logs to stdout as JSON (OSC-friendly). */
export function createLogger(level: string): Logger {
  return pino({
    level,
    // Keep secrets out of logs no matter what gets attached to a child logger.
    redact: {
      paths: ['req.headers.authorization', 'apiKey', '*.apiKey', 'context'],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type { Logger };
