/**
 * Bounded ring buffer for per-session observability streams (console + network).
 * Capacity is fixed so a long-lived or chatty page can never grow memory without
 * bound — old entries are silently dropped, newest kept.
 */
export class RingBuffer<T> {
  private readonly items: T[] = [];
  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }

  /** Most-recent `limit` entries in chronological order. */
  toArray(limit?: number): T[] {
    if (limit === undefined || limit >= this.items.length) return [...this.items];
    return this.items.slice(this.items.length - limit);
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}

/** Default number of console / network entries retained per session. */
export const LOG_BUFFER_CAPACITY = 500;
