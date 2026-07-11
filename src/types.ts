/**
 * Shared types and the structured error model.
 *
 * Every failure an agent can hit is a stable `code` + a human/agent-actionable
 * `message` that says how to recover. Errors are prompts: they steer the calling
 * agent toward the next correct step, not just report a number.
 */

export type ErrorCode =
  | 'unauthorized'
  | 'session_not_found'
  | 'session_limit_reached'
  | 'stale_ref'
  | 'element_not_actionable'
  | 'navigation_failed'
  | 'timeout'
  | 'invalid_request'
  | 'download_not_found'
  | 'not_ready'
  | 'internal';

export class BrowserhandError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  /** Optional structured hint the agent can act on. */
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    statusCode: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BrowserhandError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON(): ApiError {
    return {
      error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) },
    };
  }
}

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Convenience constructors for the common failure modes. */
export const errors = {
  unauthorized: () =>
    new BrowserhandError('unauthorized', 401, 'Missing or invalid bearer token. Send "Authorization: Bearer <BROWSERHAND_API_KEY>".'),
  sessionNotFound: (id: string) =>
    new BrowserhandError('session_not_found', 404, `No session "${id}". It may have expired or been closed — create a new one with POST /v1/sessions.`, { sessionId: id }),
  sessionLimit: (limit: number) =>
    new BrowserhandError('session_limit_reached', 429, `Maximum of ${limit} concurrent sessions reached. Close an unused session (DELETE /v1/sessions/:id) and retry.`, { limit }),
  staleRef: (ref: string) =>
    new BrowserhandError('stale_ref', 409, `Element ref "${ref}" is no longer on the page. Call GET /v1/sessions/:id/snapshot to get fresh refs, then retry.`, { ref }),
  notActionable: (ref: string, why: string) =>
    new BrowserhandError('element_not_actionable', 409, `Element ref "${ref}" could not be acted on: ${why}. Re-snapshot and confirm the element's state.`, { ref }),
  navigationFailed: (url: string, why: string) =>
    new BrowserhandError('navigation_failed', 502, `Navigation to "${url}" failed: ${why}.`, { url }),
  timeout: (what: string, ms: number) =>
    new BrowserhandError('timeout', 504, `${what} timed out after ${ms}ms.`, { timeoutMs: ms }),
  invalidRequest: (message: string) => new BrowserhandError('invalid_request', 400, message),
  downloadNotFound: (id: string) =>
    new BrowserhandError('download_not_found', 404, `No download "${id}" for this session.`, { downloadId: id }),
  notReady: () => new BrowserhandError('not_ready', 503, 'Browser pool is still warming up. Retry shortly.'),
  internal: (message: string) => new BrowserhandError('internal', 500, message),
};

/** One entry in an accessibility snapshot. */
export interface SnapshotNode {
  /** Stable, opaque ref used to address this element in action calls. */
  ref: string;
  /** ARIA-ish role (button, link, textbox, heading, ...). */
  role: string;
  /** Accessible name / visible label, trimmed. */
  name: string;
  /** Underlying tag (a, button, input, ...). */
  tag: string;
  /** Current value for form controls, if any. */
  value?: string;
  /** Nesting depth, for reconstructing the tree. */
  depth: number;
  disabled?: boolean;
  checked?: boolean;
}

export interface SnapshotResult {
  url: string;
  title: string;
  nodes: SnapshotNode[];
  /** A compact indented outline of `nodes`, easy for an agent to read. */
  outline: string;
}

export interface ConsoleLogEntry {
  type: string;
  text: string;
  timestamp: string;
}

export interface NetworkLogEntry {
  method: string;
  url: string;
  status?: number;
  resourceType?: string;
  timestamp: string;
}

export interface DownloadInfo {
  downloadId: string;
  filename: string;
  url: string;
  size: number;
  timestamp: string;
}
