import type { Page } from 'playwright';
import type { SnapshotNode, SnapshotResult } from '../types.js';

/**
 * The DOM attribute used to bind a stable snapshot ref to a real element.
 * Actions address elements by this attribute, so refs survive as long as the
 * element is still on the page — and a missing attribute is a clean stale-ref.
 */
export const REF_ATTR = 'data-bh-ref';

/**
 * Capture a selector-free accessibility snapshot of the current page: a flat,
 * ordered list of the interactive and structural elements an agent cares about,
 * each tagged with a stable `ref`, plus a compact indented outline.
 *
 * The heavy lifting runs inside the page so we assign refs and read the live DOM
 * in one pass. No LLM, no heuristics beyond "is this element worth showing an
 * agent" — deterministic and repeatable.
 */
export async function buildSnapshot(page: Page): Promise<SnapshotResult> {
  // esbuild-based runners (tsx/bun) inject `__name(fn, "name")` calls into serialized
  // page functions for keepNames; that helper is undefined inside the browser. Define
  // a no-op global first via a STRING evaluate (strings are never transformed), so the
  // injected references resolve. No-op/harmless under tsc-built output.
  await page.evaluate('window.__name = window.__name || function (f) { return f; };');

  const nodes = await page.evaluate((refAttr: string) => {
    const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'SUMMARY']);
    const STRUCTURAL_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'NAV', 'MAIN', 'HEADER', 'FOOTER', 'FORM']);
    const INTERACTIVE_ROLES = new Set([
      'button', 'link', 'checkbox', 'radio', 'textbox', 'combobox', 'menuitem',
      'tab', 'switch', 'searchbox', 'option', 'slider', 'spinbutton',
    ]);

    let counter = 0;
    const out: Array<Omit<SnapshotNode, never>> = [];

    const isVisible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      if ((el as HTMLElement).hidden) return false;
      const rect = el.getBoundingClientRect();
      // Allow zero-size for controls that are visually replaced (e.g. custom file inputs).
      const isFormControl = INTERACTIVE_TAGS.has(el.tagName);
      if (!isFormControl && rect.width === 0 && rect.height === 0) return false;
      return true;
    };

    const roleOf = (el: Element): string => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName;
      switch (tag) {
        case 'A':
          return el.hasAttribute('href') ? 'link' : 'generic';
        case 'BUTTON':
        case 'SUMMARY':
          return 'button';
        case 'SELECT':
          return 'combobox';
        case 'TEXTAREA':
          return 'textbox';
        case 'NAV':
          return 'navigation';
        case 'MAIN':
          return 'main';
        case 'HEADER':
          return 'banner';
        case 'FOOTER':
          return 'contentinfo';
        case 'FORM':
          return 'form';
        case 'OPTION':
          return 'option';
        case 'INPUT': {
          const t = (el as HTMLInputElement).type;
          if (t === 'checkbox') return 'checkbox';
          if (t === 'radio') return 'radio';
          if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
          if (t === 'search') return 'searchbox';
          return 'textbox';
        }
        default:
          if (tag.length === 2 && tag[0] === 'H') return 'heading';
          return 'generic';
      }
    };

    const accessibleName = (el: Element): string => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      const labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        const ref = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
        if (ref) return ref;
      }
      const tag = el.tagName;
      if (tag === 'INPUT') {
        const input = el as HTMLInputElement;
        // Prefer an associated <label>.
        if (input.labels && input.labels.length > 0) {
          const l = Array.from(input.labels).map((n) => n.textContent ?? '').join(' ').trim();
          if (l) return l;
        }
        if (input.placeholder) return input.placeholder.trim();
        if (input.type === 'submit' || input.type === 'button') return (input.value || '').trim();
        if (input.title) return input.title.trim();
        return '';
      }
      if (tag === 'IMG') return (el as HTMLImageElement).alt?.trim() ?? '';
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      return text.slice(0, 120);
    };

    const valueOf = (el: Element): string | undefined => {
      if (el.tagName === 'INPUT') {
        const input = el as HTMLInputElement;
        if (input.type === 'password') return '••••••';
        if (input.type === 'checkbox' || input.type === 'radio') return undefined;
        return input.value || undefined;
      }
      if (el.tagName === 'TEXTAREA') return (el as HTMLTextAreaElement).value || undefined;
      if (el.tagName === 'SELECT') return (el as HTMLSelectElement).value || undefined;
      return undefined;
    };

    const isInteresting = (el: Element): boolean => {
      if (INTERACTIVE_TAGS.has(el.tagName) || STRUCTURAL_TAGS.has(el.tagName)) return true;
      const role = el.getAttribute('role');
      if (role && (INTERACTIVE_ROLES.has(role) || role === 'heading')) return true;
      if (el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') return true;
      if ((el as HTMLElement).isContentEditable) return true;
      if (el.getAttribute('aria-label')) return true;
      return false;
    };

    const walk = (el: Element, depth: number): void => {
      // Clear any ref left over from a previous snapshot generation.
      el.removeAttribute(refAttr);
      let childDepth = depth;
      if (isVisible(el) && isInteresting(el)) {
        const ref = `e${++counter}`;
        el.setAttribute(refAttr, ref);
        const input = el as HTMLInputElement;
        out.push({
          ref,
          role: roleOf(el),
          name: accessibleName(el),
          tag: el.tagName.toLowerCase(),
          value: valueOf(el),
          depth,
          disabled: 'disabled' in input ? Boolean(input.disabled) : undefined,
          checked: input.type === 'checkbox' || input.type === 'radio' ? Boolean(input.checked) : undefined,
        });
        childDepth = depth + 1;
      }
      for (const child of Array.from(el.children)) walk(child, childDepth);
    };

    if (document.body) walk(document.body, 0);
    return out;
  }, REF_ATTR);

  const outline = nodes
    .map((n) => {
      const indent = '  '.repeat(n.depth);
      const parts = [`[${n.ref}]`, n.role];
      if (n.name) parts.push(`"${n.name}"`);
      if (n.value) parts.push(`= ${n.value}`);
      if (n.checked) parts.push('(checked)');
      if (n.disabled) parts.push('(disabled)');
      return indent + parts.join(' ');
    })
    .join('\n');

  return {
    url: page.url(),
    title: await page.title(),
    nodes,
    outline,
  };
}
