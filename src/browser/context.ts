import { z } from 'zod';
import { errors } from '../types.js';

/**
 * Portable session state (cookies + localStorage) — the shape Playwright's
 * `storageState()` produces and `newContext({ storageState })` consumes. Agents
 * export it from a logged-in session and import it into a fresh one to reuse auth
 * without the service persisting anything to disk (stateless-friendly).
 */
export const StorageStateSchema = z.object({
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string(),
        path: z.string(),
        expires: z.number(),
        httpOnly: z.boolean(),
        secure: z.boolean(),
        sameSite: z.enum(['Strict', 'Lax', 'None']),
      }),
    )
    .default([]),
  origins: z
    .array(
      z.object({
        origin: z.string(),
        localStorage: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
      }),
    )
    .default([]),
});

export type StorageState = z.infer<typeof StorageStateSchema>;

export function parseStorageState(input: unknown): StorageState {
  const result = StorageStateSchema.safeParse(input);
  if (!result.success) {
    throw errors.invalidRequest(
      'Invalid `context`: expected the object returned by GET /v1/sessions/:id/context (cookies + origins).',
    );
  }
  return result.data;
}
