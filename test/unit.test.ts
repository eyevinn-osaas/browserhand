import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { RingBuffer } from '../src/browser/capture.js';

describe('config', () => {
  it('applies defaults', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.maxConcurrentSessions).toBe(5);
    expect(c.sessionTimeoutMs).toBe(300_000);
    expect(c.apiKey).toBeUndefined();
  });

  it('reads and coerces env values', () => {
    const c = loadConfig({ PORT: '9000', MAX_CONCURRENT_SESSIONS: '2', BROWSERHAND_API_KEY: 'secret' });
    expect(c.port).toBe(9000);
    expect(c.maxConcurrentSessions).toBe(2);
    expect(c.apiKey).toBe('secret');
  });

  it('rejects invalid values with a helpful message', () => {
    expect(() => loadConfig({ MAX_CONCURRENT_SESSIONS: '-1' })).toThrow(/configuration/i);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/configuration/i);
  });
});

describe('RingBuffer', () => {
  it('keeps only the most recent entries up to capacity', () => {
    const rb = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) rb.push(n);
    expect(rb.size).toBe(3);
    expect(rb.toArray()).toEqual([3, 4, 5]);
    expect(rb.toArray(2)).toEqual([4, 5]);
  });
});
