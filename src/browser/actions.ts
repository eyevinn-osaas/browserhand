import type { Locator, Page } from 'playwright';
import { errors } from '../types.js';
import { REF_ATTR } from './snapshot.js';

/** Per-action ceiling so a stuck page can never wedge a request forever. */
export const ACTION_TIMEOUT_MS = 15_000;

/**
 * Resolve a snapshot ref to a live element, or fail with an instructive stale-ref
 * error that tells the agent to re-snapshot. This is the single choke point every
 * ref-addressed action goes through.
 */
export async function resolveRef(page: Page, ref: string): Promise<Locator> {
  const locator = page.locator(`[${REF_ATTR}="${cssEscape(ref)}"]`);
  const count = await locator.count();
  if (count === 0) throw errors.staleRef(ref);
  return locator.first();
}

function cssEscape(value: string): string {
  // Refs are of the form e123, but escape defensively for the attribute selector.
  return value.replace(/["\\]/g, '\\$&');
}

/** Map a raw Playwright error onto our structured, agent-actionable model. */
function mapActionError(ref: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/Timeout .* exceeded/i.test(message)) {
    throw errors.notActionable(ref, 'the element did not become actionable in time (it may be hidden, disabled, or covered)');
  }
  if (/detached|not attached|no longer/i.test(message)) {
    throw errors.staleRef(ref);
  }
  throw errors.notActionable(ref, message.split('\n')[0] ?? 'unknown reason');
}

export async function clickRef(page: Page, ref: string): Promise<void> {
  const el = await resolveRef(page, ref);
  try {
    await el.click({ timeout: ACTION_TIMEOUT_MS });
  } catch (err) {
    mapActionError(ref, err);
  }
}

export async function typeRef(page: Page, ref: string, text: string, submit = false): Promise<void> {
  const el = await resolveRef(page, ref);
  try {
    await el.fill(text, { timeout: ACTION_TIMEOUT_MS });
    if (submit) await el.press('Enter', { timeout: ACTION_TIMEOUT_MS });
  } catch (err) {
    mapActionError(ref, err);
  }
}

export async function selectRef(page: Page, ref: string, values: string[]): Promise<string[]> {
  const el = await resolveRef(page, ref);
  try {
    return await el.selectOption(values, { timeout: ACTION_TIMEOUT_MS });
  } catch (err) {
    mapActionError(ref, err);
  }
}

export async function hoverRef(page: Page, ref: string): Promise<void> {
  const el = await resolveRef(page, ref);
  try {
    await el.hover({ timeout: ACTION_TIMEOUT_MS });
  } catch (err) {
    mapActionError(ref, err);
  }
}

export async function uploadToRef(
  page: Page,
  ref: string,
  files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
): Promise<void> {
  const el = await resolveRef(page, ref);
  try {
    await el.setInputFiles(
      files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.buffer })),
      { timeout: ACTION_TIMEOUT_MS },
    );
  } catch (err) {
    mapActionError(ref, err);
  }
}

export async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
}

export async function scroll(page: Page, direction: 'up' | 'down' | 'left' | 'right', ref?: string): Promise<void> {
  if (ref) {
    const el = await resolveRef(page, ref);
    try {
      await el.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
      return;
    } catch (err) {
      mapActionError(ref, err);
    }
  }
  const delta = 600;
  const [dx, dy] =
    direction === 'down' ? [0, delta] :
    direction === 'up' ? [0, -delta] :
    direction === 'right' ? [delta, 0] : [-delta, 0];
  await page.mouse.wheel(dx, dy);
}

export type WaitParams = { text?: string; ref?: string; timeoutMs?: number };

export async function waitFor(page: Page, params: WaitParams): Promise<void> {
  const timeout = params.timeoutMs ?? ACTION_TIMEOUT_MS;
  if (params.ref) {
    const locator = page.locator(`[${REF_ATTR}="${cssEscape(params.ref)}"]`);
    await locator.waitFor({ state: 'visible', timeout }).catch(() => {
      throw errors.timeout(`Waiting for ref "${params.ref}"`, timeout);
    });
    return;
  }
  if (params.text) {
    await page.getByText(params.text, { exact: false }).first().waitFor({ state: 'visible', timeout }).catch(() => {
      throw errors.timeout(`Waiting for text "${params.text}"`, timeout);
    });
    return;
  }
  await page.waitForTimeout(Math.min(timeout, 5_000));
}
