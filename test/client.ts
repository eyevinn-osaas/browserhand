import type { SnapshotNode } from '../src/types.js';

/** Minimal typed HTTP client for the tests. */
export function makeClient(baseUrl: string, headers: Record<string, string> = {}) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res;
  };
  return {
    async json<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
      const res = await call(method, path, body);
      return { status: res.status, body: (await res.json()) as T };
    },
    async raw(method: string, path: string): Promise<{ status: number; contentType: string | null; bytes: Buffer }> {
      const res = await call(method, path);
      return { status: res.status, contentType: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
    },
  };
}

export const findNode = (nodes: SnapshotNode[], pred: (n: SnapshotNode) => boolean): SnapshotNode => {
  const n = nodes.find(pred);
  if (!n) throw new Error('expected snapshot node not found');
  return n;
};
