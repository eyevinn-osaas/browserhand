/**
 * JSON Schemas for every route. These do double duty: Fastify validates requests
 * against them, and @fastify/swagger turns them into the OpenAPI spec an agent (or
 * OSC's MCP layer) reads to learn the tools. Descriptions are written for that
 * agent audience — say plainly what each field is and how to get it.
 */

export const errorResponse = {
  type: 'object',
  description: 'Structured error. `code` is stable and machine-readable; `message` states how to recover.',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Stable error code, e.g. "stale_ref", "session_not_found".' },
        message: { type: 'string', description: 'Human/agent-readable explanation and recovery hint.' },
        details: { type: 'object', additionalProperties: true },
      },
      required: ['code', 'message'],
      additionalProperties: true,
    },
  },
  required: ['error'],
  additionalProperties: false,
} as const;

const sessionIdParam = {
  type: 'object',
  properties: { id: { type: 'string', description: 'Session id from POST /v1/sessions.' } },
  required: ['id'],
} as const;

const refProp = {
  type: 'string',
  description: 'Element ref (e.g. "e12") from the latest GET /snapshot. Re-snapshot if you get a stale_ref error.',
} as const;

export const createSessionBody = {
  type: 'object',
  additionalProperties: false,
  description: 'Options for a new browser session. All fields optional.',
  properties: {
    viewport: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', minimum: 200, maximum: 3840 },
        height: { type: 'integer', minimum: 200, maximum: 2160 },
      },
      required: ['width', 'height'],
      description: 'Browser viewport size. Defaults to 1280x800.',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1000,
      description: 'Idle timeout for this session in ms. Defaults to the server setting.',
    },
    context: {
      type: 'object',
      additionalProperties: true,
      description: 'Portable state from GET /v1/sessions/:id/context, to reuse cookies/localStorage (e.g. a logged-in session).',
    },
  },
} as const;

export const navigateBody = {
  type: 'object',
  additionalProperties: false,
  properties: { url: { type: 'string', description: 'Absolute URL to navigate to (http/https).' } },
  required: ['url'],
} as const;

export const clickBody = {
  type: 'object', additionalProperties: false,
  properties: { ref: refProp }, required: ['ref'],
} as const;

export const typeBody = {
  type: 'object', additionalProperties: false,
  properties: {
    ref: refProp,
    text: { type: 'string', description: 'Text to fill into the field (replaces existing value).' },
    submit: { type: 'boolean', description: 'Press Enter after typing. Default false.' },
  },
  required: ['ref', 'text'],
} as const;

export const selectBody = {
  type: 'object', additionalProperties: false,
  properties: {
    ref: refProp,
    values: { type: 'array', items: { type: 'string' }, description: 'Option value(s) or label(s) to select.' },
  },
  required: ['ref', 'values'],
} as const;

export const hoverBody = clickBody;

export const pressBody = {
  type: 'object', additionalProperties: false,
  properties: { key: { type: 'string', description: 'Key or chord, e.g. "Enter", "Escape", "Control+A".' } },
  required: ['key'],
} as const;

export const scrollBody = {
  type: 'object', additionalProperties: false,
  properties: {
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (ignored if ref is given).' },
    ref: { type: 'string', description: 'Optional: scroll this element into view instead of scrolling the viewport.' },
  },
} as const;

export const waitBody = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string', description: 'Wait until this visible text appears.' },
    ref: { type: 'string', description: 'Wait until this element ref is visible.' },
    timeoutMs: { type: 'integer', minimum: 1, description: 'Max wait in ms. Default 15000.' },
  },
} as const;

export const uploadBody = {
  type: 'object', additionalProperties: false,
  properties: {
    ref: refProp,
    files: {
      type: 'array',
      description: 'Files to set on a file input.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'File name.' },
          mimeType: { type: 'string', description: 'MIME type, e.g. "text/plain".' },
          contentBase64: { type: 'string', description: 'File contents, base64-encoded.' },
        },
        required: ['name', 'mimeType', 'contentBase64'],
      },
      minItems: 1,
    },
  },
  required: ['ref', 'files'],
} as const;

export const logsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['console', 'network'], description: 'Which log stream to return.' },
    limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Most-recent N entries. Default all (max 500).' },
  },
  required: ['type'],
} as const;

export const screenshotQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fullPage: { type: 'boolean', description: 'Capture the full scrollable page. Default false (viewport only).' },
    ref: { type: 'string', description: 'Optional: screenshot just this element.' },
  },
} as const;

export { sessionIdParam };
