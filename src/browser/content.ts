import type { Page } from 'playwright';

/** Max characters of readable text returned by default before truncation. */
export const MAX_CONTENT_CHARS = 20_000;

export interface PageContent {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

/**
 * Return the human-readable text of the page (roughly what a reader sees), for
 * an agent to read or extract from. Deterministic — no model, no summarization.
 */
export async function readContent(page: Page, maxChars = MAX_CONTENT_CHARS): Promise<PageContent> {
  const text = await page.evaluate(() => {
    const body = document.body;
    if (!body) return '';
    return (body.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  });
  const truncated = text.length > maxChars;
  return {
    url: page.url(),
    title: await page.title(),
    text: truncated ? text.slice(0, maxChars) : text,
    truncated,
  };
}
