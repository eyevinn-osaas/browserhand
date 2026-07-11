import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import type { Logger } from '../logger.js';
import {
  clickRef, hoverRef, pressKey, scroll, selectRef, typeRef, uploadToRef, waitFor,
  type WaitParams,
} from '../browser/actions.js';
import { buildSnapshot } from '../browser/snapshot.js';
import { readContent, type PageContent } from '../browser/content.js';
import { LOG_BUFFER_CAPACITY, RingBuffer } from '../browser/capture.js';
import {
  errors,
  type ConsoleLogEntry, type DownloadInfo, type NetworkLogEntry, type SnapshotResult,
} from '../types.js';

export interface SessionCreateOptions {
  viewport?: { width: number; height: number };
  /** Override the pool's idle timeout for this session. */
  timeoutMs?: number;
}

interface StoredDownload {
  info: DownloadInfo;
  path: string;
}

/**
 * One isolated browser session = one Playwright BrowserContext + its page, plus
 * the observability buffers and downloads captured for it. All browser effects
 * for a session go through here; the pool owns lifecycle.
 */
export class Session {
  readonly id = randomUUID();
  readonly createdAt = new Date();
  private lastActivityMs = Date.now();
  private closed = false;

  private readonly consoleLog = new RingBuffer<ConsoleLogEntry>(LOG_BUFFER_CAPACITY);
  private readonly networkLog = new RingBuffer<NetworkLogEntry>(LOG_BUFFER_CAPACITY);
  private readonly downloads = new Map<string, StoredDownload>();

  constructor(
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly log: Logger,
    readonly idleTimeoutMs: number,
  ) {
    this.attachListeners();
  }

  private attachListeners(): void {
    this.page.on('console', (msg) => {
      this.consoleLog.push({ type: msg.type(), text: msg.text(), timestamp: new Date().toISOString() });
    });
    this.page.on('pageerror', (err) => {
      this.consoleLog.push({ type: 'error', text: err.message, timestamp: new Date().toISOString() });
    });
    this.context.on('response', (res) => {
      this.networkLog.push({
        method: res.request().method(),
        url: res.url(),
        status: res.status(),
        resourceType: res.request().resourceType(),
        timestamp: new Date().toISOString(),
      });
    });
    this.page.on('download', (download) => {
      // Resolve the completed file lazily; failures here must not crash the session.
      void (async () => {
        try {
          const path = await download.path();
          if (!path) return;
          const id = randomUUID();
          const size = statSync(path).size;
          this.downloads.set(id, {
            path,
            info: {
              downloadId: id,
              filename: download.suggestedFilename(),
              url: download.url(),
              size,
              timestamp: new Date().toISOString(),
            },
          });
        } catch (err) {
          this.log.warn({ err }, 'failed to capture download');
        }
      })();
    });
  }

  private touch(): void {
    this.lastActivityMs = Date.now();
  }

  get idleMs(): number {
    return Date.now() - this.lastActivityMs;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private assertOpen(): void {
    if (this.closed) throw errors.sessionNotFound(this.id);
  }

  // --- Navigation ---------------------------------------------------------

  async navigate(url: string): Promise<{ url: string; status: number | null }> {
    this.assertOpen();
    this.touch();
    try {
      const res = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      return { url: this.page.url(), status: res?.status() ?? null };
    } catch (err) {
      throw errors.navigationFailed(url, err instanceof Error ? err.message.split('\n')[0]! : String(err));
    }
  }

  async back(): Promise<{ url: string }> {
    this.assertOpen();
    this.touch();
    await this.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    return { url: this.page.url() };
  }

  async forward(): Promise<{ url: string }> {
    this.assertOpen();
    this.touch();
    await this.page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    return { url: this.page.url() };
  }

  async reload(): Promise<{ url: string }> {
    this.assertOpen();
    this.touch();
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    return { url: this.page.url() };
  }

  // --- Perception ---------------------------------------------------------

  async snapshot(): Promise<SnapshotResult> {
    this.assertOpen();
    this.touch();
    return buildSnapshot(this.page);
  }

  async content(): Promise<PageContent> {
    this.assertOpen();
    this.touch();
    return readContent(this.page);
  }

  async screenshot(opts: { fullPage?: boolean; ref?: string } = {}): Promise<Buffer> {
    this.assertOpen();
    this.touch();
    if (opts.ref) {
      const { resolveRef } = await import('../browser/actions.js');
      const el = await resolveRef(this.page, opts.ref);
      return el.screenshot();
    }
    return this.page.screenshot({ fullPage: opts.fullPage ?? false });
  }

  // --- Actions ------------------------------------------------------------

  async click(ref: string): Promise<void> {
    this.assertOpen(); this.touch();
    await clickRef(this.page, ref);
  }
  async type(ref: string, text: string, submit = false): Promise<void> {
    this.assertOpen(); this.touch();
    await typeRef(this.page, ref, text, submit);
  }
  async select(ref: string, values: string[]): Promise<string[]> {
    this.assertOpen(); this.touch();
    return selectRef(this.page, ref, values);
  }
  async hover(ref: string): Promise<void> {
    this.assertOpen(); this.touch();
    await hoverRef(this.page, ref);
  }
  async press(key: string): Promise<void> {
    this.assertOpen(); this.touch();
    await pressKey(this.page, key);
  }
  async scroll(direction: 'up' | 'down' | 'left' | 'right', ref?: string): Promise<void> {
    this.assertOpen(); this.touch();
    await scroll(this.page, direction, ref);
  }
  async wait(params: WaitParams): Promise<void> {
    this.assertOpen(); this.touch();
    await waitFor(this.page, params);
  }
  async upload(ref: string, files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void> {
    this.assertOpen(); this.touch();
    await uploadToRef(this.page, ref, files);
  }

  // --- Observability & artifacts -----------------------------------------

  logs(type: 'console' | 'network', limit?: number): ConsoleLogEntry[] | NetworkLogEntry[] {
    this.assertOpen();
    return type === 'console' ? this.consoleLog.toArray(limit) : this.networkLog.toArray(limit);
  }

  listDownloads(): DownloadInfo[] {
    this.assertOpen();
    return [...this.downloads.values()].map((d) => d.info);
  }

  getDownloadPath(downloadId: string): { path: string; info: DownloadInfo } {
    this.assertOpen();
    const d = this.downloads.get(downloadId);
    if (!d) throw errors.downloadNotFound(downloadId);
    return { path: d.path, info: d.info };
  }

  /** Export cookies + localStorage for reuse in another session. */
  async exportContext(): Promise<unknown> {
    this.assertOpen();
    this.touch();
    return this.context.storageState();
  }

  info(): { sessionId: string; status: 'open' | 'closed'; createdAt: string; idleMs: number; url: string } {
    return {
      sessionId: this.id,
      status: this.closed ? 'closed' : 'open',
      createdAt: this.createdAt.toISOString(),
      idleMs: this.idleMs,
      url: this.closed ? '' : this.page.url(),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.consoleLog.clear();
    this.networkLog.clear();
    this.downloads.clear();
    await this.context.close().catch((err) => this.log.warn({ err, sessionId: this.id }, 'context close failed'));
  }
}
