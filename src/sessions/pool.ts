import { type Browser, chromium } from 'playwright';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { parseStorageState } from '../browser/context.js';
import { errors } from '../types.js';
import { Session, type SessionCreateOptions } from './session.js';

/**
 * Owns the single shared Chromium instance and every open Session. Enforces the
 * concurrency cap, sweeps idle sessions, and exposes the browser-level CDP
 * endpoint that backs the /v1/connect proxy.
 */
export class SessionPool {
  private browser: Browser | null = null;
  private cdpWsEndpoint: string | null = null;
  private readonly sessions = new Map<string, Session>();
  private sweeper: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(private readonly config: Config, private readonly log: Logger) {}

  async start(): Promise<void> {
    const noSandbox = process.env.CHROMIUM_NO_SANDBOX === 'true';
    const args = [`--remote-debugging-port=${this.config.cdpPort}`, '--remote-debugging-address=127.0.0.1'];
    if (noSandbox) args.push('--no-sandbox');

    this.browser = await chromium.launch({ headless: true, args });
    this.cdpWsEndpoint = await this.discoverCdpEndpoint();

    // Sweep idle sessions once per 30s (or sooner if the timeout is short).
    const interval = Math.max(5_000, Math.min(30_000, Math.floor(this.config.sessionTimeoutMs / 2)));
    this.sweeper = setInterval(() => void this.sweepIdle(), interval);
    this.log.info({ cdp: Boolean(this.cdpWsEndpoint) }, 'session pool started');
  }

  private async discoverCdpEndpoint(): Promise<string | null> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.config.cdpPort}/json/version`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { webSocketDebuggerUrl?: string };
      return body.webSocketDebuggerUrl ?? null;
    } catch (err) {
      this.log.warn({ err }, 'CDP endpoint unavailable — /v1/connect will be disabled');
      return null;
    }
  }

  get isReady(): boolean {
    return this.browser !== null && !this.draining;
  }

  getCdpEndpoint(): string | null {
    return this.cdpWsEndpoint;
  }

  get size(): number {
    return this.sessions.size;
  }

  async createSession(opts: SessionCreateOptions & { context?: unknown } = {}): Promise<Session> {
    if (!this.browser || this.draining) throw errors.notReady();
    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      throw errors.sessionLimit(this.config.maxConcurrentSessions);
    }

    const storageState = opts.context !== undefined ? parseStorageState(opts.context) : undefined;
    const context = await this.browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      acceptDownloads: true,
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();
    const idleTimeout = opts.timeoutMs ?? this.config.sessionTimeoutMs;
    const session = new Session(context, page, this.log.child({ sessionId: '(pending)' }), idleTimeout);
    this.sessions.set(session.id, session);
    this.log.info({ sessionId: session.id, count: this.sessions.size }, 'session created');
    return session;
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.isClosed) throw errors.sessionNotFound(id);
    return session;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  async destroy(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw errors.sessionNotFound(id);
    this.sessions.delete(id);
    await session.close();
    this.log.info({ sessionId: id, count: this.sessions.size }, 'session closed');
  }

  private async sweepIdle(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.idleMs >= session.idleTimeoutMs) {
        this.log.info({ sessionId: session.id, idleMs: session.idleMs }, 'closing idle session');
        this.sessions.delete(session.id);
        await session.close();
      }
    }
  }

  /** Graceful shutdown: stop accepting work, close all sessions, then the browser. */
  async stop(): Promise<void> {
    this.draining = true;
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
    await this.browser?.close().catch((err) => this.log.warn({ err }, 'browser close failed'));
    this.browser = null;
    this.log.info('session pool stopped');
  }
}
