import type { FastifyReply, FastifyRequest } from 'fastify';
import { errors } from '../types.js';

/**
 * Bearer-token guard. When `BROWSERHAND_API_KEY` is configured, every protected
 * request must send `Authorization: Bearer <token>`. When it is unset the service
 * runs open (intended for trusted networks) — this is documented, not accidental.
 */
export function makeAuthHook(apiKey: string | undefined) {
  return async function authHook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!apiKey) return;
    const header = request.headers.authorization;
    const expected = `Bearer ${apiKey}`;
    // Constant-time-ish compare on equal-length strings; length mismatch is an early reject.
    if (!header || header.length !== expected.length || !timingSafeEqual(header, expected)) {
      throw errors.unauthorized();
    }
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
