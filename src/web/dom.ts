// Tiny DOM helpers. Nothing here ever assigns HTML strings; the single place that
// does (rendered Markdown) lives in app.ts and goes through renderMarkdown().

export type Child = Node | string | number | null | undefined | false;
export type Handler = (event: Event) => void;
export type Props = Record<string, string | number | boolean | Handler | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on:') && typeof value === 'function') {
        el.addEventListener(key.slice(3), value);
      } else if (key === 'class') {
        el.className = String(value);
      } else if (key === 'style' || key.toLowerCase().startsWith('on')) {
        // Inline styles are blocked by the CSP and inline handlers are never used.
        throw new Error(`Unsupported attribute: ${key}`);
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers without async clipboard access.
    const area = h('textarea', { class: 'visually-hidden', 'aria-hidden': 'true', tabindex: '-1' });
    area.value = text;
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}
