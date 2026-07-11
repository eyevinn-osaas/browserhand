/**
 * Offline evaluation harness. Boots browserhand + a local fixture server, drives
 * each task in tasks.json through the real HTTP API as an agent would, and checks
 * a programmatic success condition. Reports per-task pass/fail, API-call count and
 * wall-clock, plus aggregate accuracy. Exits non-zero if any task fails.
 *
 * Run: npm run eval            (all tasks)
 *      npm run eval -- --id=x  (one task)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startBrowserhand, startFixtures } from './harness.js';
import type { SnapshotNode } from '../src/types.js';

interface Step { op: string; [k: string]: unknown }
interface Expect { kind: string; value?: unknown }
interface Task { id: string; goal: string; steps: Step[]; expect: Expect }

const here = dirname(fileURLToPath(import.meta.url));
const { tasks } = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8')) as { tasks: Task[] };

const idFilter = process.argv.find((a) => a.startsWith('--id='))?.slice('--id='.length);
const selected = idFilter ? tasks.filter((t) => t.id === idFilter) : tasks;

function makeApi(baseUrl: string) {
  let calls = 0;
  const call = async (method: string, path: string, body?: unknown) => {
    calls++;
    return fetch(baseUrl + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  return {
    calls: () => calls,
    json: async <T = any>(m: string, p: string, b?: unknown) => {
      const r = await call(m, p, b);
      return { status: r.status, body: (await r.json()) as T };
    },
    raw: async (m: string, p: string) => {
      const r = await call(m, p);
      return { status: r.status, contentType: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) };
    },
  };
}

const findRef = (nodes: SnapshotNode[], sel: { role?: string; name?: string; tag?: string }): string => {
  const n = nodes.find((x) =>
    (sel.role === undefined || x.role === sel.role) &&
    (sel.name === undefined || x.name === sel.name) &&
    (sel.tag === undefined || x.tag === sel.tag));
  if (!n) throw new Error(`no element matched ${JSON.stringify(sel)}`);
  return n.ref;
};

interface RunState {
  sessionId: string;
  nodes: SnapshotNode[];
  title: string;
  lastUrl: string;
  lastStatus: number;
  lastError: { code?: string } | null;
  lastBytes: Buffer | null;
  lastContentType: string | null;
  context: unknown;
  tokenA: string;
}

async function runTask(api: ReturnType<typeof makeApi>, fxUrl: (n: string) => string, task: Task): Promise<{ ok: boolean; reason?: string }> {
  const created = await api.json<{ sessionId: string }>('POST', '/v1/sessions', {});
  const s: RunState = {
    sessionId: created.body.sessionId, nodes: [], title: '', lastUrl: '', lastStatus: created.status,
    lastError: null, lastBytes: null, lastContentType: null, context: undefined, tokenA: '',
  };
  const base = () => `/v1/sessions/${s.sessionId}`;

  try {
    for (const step of task.steps) {
      switch (step.op) {
        case 'navigate': {
          const r = await api.json<{ url: string }>('POST', `${base()}/navigate`, { url: fxUrl(step.fixture as string) });
          s.lastStatus = r.status; s.lastUrl = r.body.url ?? '';
          break;
        }
        case 'navigateNoUrl': {
          const r = await api.json('POST', `${base()}/navigate`, {});
          s.lastStatus = r.status;
          break;
        }
        case 'snapshot': {
          const r = await api.json<{ nodes: SnapshotNode[]; title: string }>('GET', `${base()}/snapshot`);
          s.nodes = r.body.nodes; s.title = r.body.title;
          break;
        }
        case 'content': {
          const r = await api.json<{ text: string }>('GET', `${base()}/content`);
          s.lastUrl = s.lastUrl; (s as unknown as { text: string }).text = r.body.text;
          break;
        }
        case 'type':
          await api.json('POST', `${base()}/type`, { ref: findRef(s.nodes, step), text: step.text });
          break;
        case 'click':
          await api.json('POST', `${base()}/click`, { ref: findRef(s.nodes, step) });
          break;
        case 'select':
          await api.json('POST', `${base()}/select`, { ref: findRef(s.nodes, step), values: step.values });
          break;
        case 'upload':
          await api.json('POST', `${base()}/upload`, {
            ref: findRef(s.nodes, step),
            files: [{ name: step.filename, mimeType: 'text/plain', contentBase64: Buffer.from(String(step.text)).toString('base64') }],
          });
          break;
        case 'back': {
          const r = await api.json<{ url: string }>('POST', `${base()}/back`);
          s.lastUrl = r.body.url ?? '';
          break;
        }
        case 'reload': {
          const r = await api.json<{ url: string }>('POST', `${base()}/reload`);
          s.lastUrl = r.body.url ?? '';
          break;
        }
        case 'waitText':
          await api.json('POST', `${base()}/wait`, { text: step.text });
          break;
        case 'screenshot': {
          const r = await api.raw('GET', `${base()}/screenshot`);
          s.lastBytes = r.bytes; s.lastContentType = r.contentType;
          break;
        }
        case 'screenshotRef': {
          const r = await api.raw('GET', `${base()}/screenshot?ref=${findRef(s.nodes, step)}`);
          s.lastBytes = r.bytes; s.lastContentType = r.contentType;
          break;
        }
        case 'consoleLogs':
          await api.json('GET', `${base()}/logs?type=console`);
          break;
        case 'listSessions':
          (s as unknown as { sessions: Array<{ sessionId: string }> }).sessions =
            (await api.json<{ sessions: Array<{ sessionId: string }> }>('GET', '/v1/sessions')).body.sessions;
          break;
        case 'exportContext': {
          s.tokenA = (await api.json<{ text: string }>('GET', `${base()}/content`)).body.text;
          s.context = (await api.json('GET', `${base()}/context`)).body;
          break;
        }
        case 'newSessionWithContext': {
          await api.json('DELETE', base());
          s.sessionId = (await api.json<{ sessionId: string }>('POST', '/v1/sessions', { context: s.context })).body.sessionId;
          break;
        }
        case 'clickRefExpectError': {
          const r = await api.json<{ error: { code: string } }>('POST', `${base()}/click`, { ref: step.ref });
          s.lastStatus = r.status; s.lastError = r.body.error ?? null;
          break;
        }
        case 'getMissingSession': {
          const r = await api.json('GET', '/v1/sessions/nonexistent-session-id');
          s.lastStatus = r.status;
          break;
        }
        default:
          throw new Error(`unknown step op: ${step.op}`);
      }
    }

    const ok = await check(api, s, task.expect);
    return ok;
  } finally {
    await api.json('DELETE', base()).catch(() => undefined);
  }
}

async function check(api: ReturnType<typeof makeApi>, s: RunState, exp: Expect): Promise<{ ok: boolean; reason?: string }> {
  const fail = (reason: string) => ({ ok: false, reason });
  const contentText = async () =>
    (await api.json<{ text: string }>('GET', `/v1/sessions/${s.sessionId}/content`)).body.text;
  switch (exp.kind) {
    case 'ok':
      return { ok: true };
    case 'titleEquals':
      return s.title === exp.value ? { ok: true } : fail(`title "${s.title}" !== "${String(exp.value)}"`);
    case 'minNodes':
      return s.nodes.length >= Number(exp.value) ? { ok: true } : fail(`only ${s.nodes.length} nodes`);
    case 'contentContains': {
      const text = await contentText();
      return text.includes(String(exp.value)) ? { ok: true } : fail(`content missing "${String(exp.value)}"`);
    }
    case 'urlContains':
      return s.lastUrl.includes(String(exp.value)) ? { ok: true } : fail(`url "${s.lastUrl}" missing "${String(exp.value)}"`);
    case 'screenshotPng':
      return s.lastBytes && s.lastContentType === 'image/png' && s.lastBytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
        ? { ok: true } : fail('not a PNG');
    case 'minNetworkLogs': {
      const logs = (await api.json<{ entries: unknown[] }>('GET', `/v1/sessions/${s.sessionId}/logs?type=network`)).body.entries;
      return logs.length >= Number(exp.value) ? { ok: true } : fail(`only ${logs.length} network logs`);
    }
    case 'downloadContains': {
      let downloads: Array<{ downloadId: string }> = [];
      for (let i = 0; i < 20 && downloads.length === 0; i++) {
        downloads = (await api.json<{ downloads: typeof downloads }>('GET', `/v1/sessions/${s.sessionId}/downloads`)).body.downloads;
        if (downloads.length === 0) await new Promise((r) => setTimeout(r, 150));
      }
      if (downloads.length === 0) return fail('no download captured');
      const file = await api.raw('GET', `/v1/sessions/${s.sessionId}/downloads/${downloads[0]!.downloadId}`);
      return file.bytes.toString().includes(String(exp.value)) ? { ok: true } : fail('download bytes mismatch');
    }
    case 'tokenReused': {
      const tokenB = await contentText();
      return s.tokenA && tokenB === s.tokenA ? { ok: true } : fail(`token not reused (A="${s.tokenA}" B="${tokenB}")`);
    }
    case 'errorCode':
      return s.lastError?.code === exp.value ? { ok: true } : fail(`error code "${s.lastError?.code}" !== "${String(exp.value)}"`);
    case 'statusEquals':
      return s.lastStatus === Number(exp.value) ? { ok: true } : fail(`status ${s.lastStatus} !== ${String(exp.value)}`);
    case 'sessionListed': {
      const sessions = (s as unknown as { sessions?: Array<{ sessionId: string }> }).sessions ?? [];
      return sessions.some((x) => x.sessionId === s.sessionId) ? { ok: true } : fail('session not listed');
    }
    default:
      return fail(`unknown expect kind: ${exp.kind}`);
  }
}

async function main(): Promise<void> {
  const fx = await startFixtures();
  const bh = await startBrowserhand();
  console.log(`\nbrowserhand eval — ${selected.length} task(s)\n${'='.repeat(64)}`);
  let passed = 0;
  const rows: string[] = [];
  try {
    for (const task of selected) {
      const api = makeApi(bh.baseUrl);
      const t0 = performance.now();
      let result: { ok: boolean; reason?: string };
      try {
        result = await runTask(api, fx.url, task);
      } catch (err) {
        result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      const ms = Math.round(performance.now() - t0);
      if (result.ok) passed++;
      const mark = result.ok ? 'PASS' : 'FAIL';
      rows.push(`${mark}  ${task.id.padEnd(24)} ${String(api.calls()).padStart(2)} calls  ${String(ms).padStart(5)}ms${result.ok ? '' : `  — ${result.reason}`}`);
    }
  } finally {
    await bh.close();
    await fx.close();
  }
  console.log(rows.join('\n'));
  const pct = Math.round((passed / selected.length) * 100);
  console.log(`${'='.repeat(64)}\naccuracy: ${passed}/${selected.length} (${pct}%)\n`);
  process.exit(passed === selected.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
