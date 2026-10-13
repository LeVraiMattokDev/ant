import type { BrowserElement } from '@ant/shared';

/** Selector of the elements an agent can interact with (`read`). */
export const INTERACTIVE_SELECTOR =
  'a, button, input, textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [contenteditable=true]';
export const MAX_ELEMENTS = 300;
export const MAX_NAME_CHARS = 120;
export const MAX_TEXT_CHARS = 50_000;
export const REF_ATTR = 'data-ant-ref';

/** Raw facts collected in the page for one element (see `READ_PAGE_SCRIPT`). */
export interface RawElement {
  ref: string;
  tag: string;
  type: string;
  role: string;
  ariaLabel: string;
  labelText: string;
  innerText: string;
  placeholder: string;
  value: string;
  title: string;
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function capText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Implicit ARIA role of an element (explicit `role` wins). */
export function roleOf(raw: Pick<RawElement, 'tag' | 'type' | 'role'>): string {
  const explicit = raw.role.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const type = raw.type.toLowerCase();
  switch (raw.tag.toLowerCase()) {
    case 'a':
      return 'link';
    case 'button':
      return 'button';
    case 'select':
      return 'combobox';
    case 'textarea':
      return 'textbox';
    case 'input':
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      return 'textbox';
    default:
      return 'textbox'; // [contenteditable=true]
  }
}

/** aria-label || label text || innerText || placeholder || value || title, whitespace-collapsed, ≤ 120 chars. */
export function nameOf(raw: Omit<RawElement, 'ref' | 'role'>): string {
  // Never expose what is typed in a password field.
  const value = raw.type.toLowerCase() === 'password' ? '' : raw.value;
  for (const candidate of [raw.ariaLabel, raw.labelText, raw.innerText, raw.placeholder, value, raw.title]) {
    const name = collapseWhitespace(candidate ?? '');
    if (name) return capText(name, MAX_NAME_CHARS);
  }
  return '';
}

export function describeElement(raw: RawElement): BrowserElement {
  return { ref: raw.ref, role: roleOf(raw), name: nameOf(raw) };
}

export function describeElements(raws: readonly RawElement[]): BrowserElement[] {
  return raws.slice(0, MAX_ELEMENTS).map(describeElement);
}

/**
 * Pin set by `inspect` on the exact node shown on an approval card. Unlike refs, `read` never
 * clears it: an approved action still targets that node after other reads renumbered the refs.
 */
export const PIN_ATTR = 'data-ant-pin';
/** Format of a pin: the lowercase UUID (`randomUUID()`) that `inspect` issued. */
export const PIN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isPin(value: string): boolean {
  return PIN_RE.test(value);
}

/** `pin` returned by `inspect` (a UUID) → CSS selector. */
export function pinSelector(pin: string): string {
  if (!isPin(pin)) throw new Error(`Épingle d'élément invalide : « ${pin.slice(0, 64)} ».`);
  return `[${PIN_ATTR}="${pin}"]`;
}

/** `ref` from a previous read ("e12") → CSS selector. */
export function refSelector(ref: string): string {
  const trimmed = ref.trim();
  if (!/^e\d{1,6}$/.test(trimmed)) throw new Error(`Référence d'élément invalide : « ${ref} » (attendu « e12 »).`);
  return `[${REF_ATTR}="${trimmed}"]`;
}

export function pageText(raw: string): string {
  const text = raw.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[… texte tronqué à ${MAX_TEXT_CHARS} caractères]` : text;
}

/*
 * In-page scripts are plain JS strings evaluated with embedded JSON arguments: they never go
 * through a TS transpiler (tsx/esbuild `keepNames` would inject `__name()` helpers that do not
 * exist in the page).
 */

const COLLECT_ELEMENT_JS = `function (el, ref) {
  var labelText = '';
  if (el.labels && el.labels.length) {
    labelText = Array.prototype.map.call(el.labels, function (l) { return l.innerText || ''; }).join(' ');
  } else if (el.closest) {
    var l = el.closest('label');
    if (l) labelText = l.innerText || '';
  }
  return {
    ref: ref,
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || '',
    role: el.getAttribute('role') || '',
    ariaLabel: el.getAttribute('aria-label') || '',
    labelText: labelText,
    innerText: el.tagName === 'SELECT' ? '' : (el.innerText || ''),
    placeholder: el.getAttribute('placeholder') || '',
    value: el.tagName === 'SELECT'
      ? (el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].label : '')
      : (typeof el.value === 'string' ? el.value : ''),
    title: el.getAttribute('title') || ''
  };
}`;

const IS_VISIBLE_JS = `function (el) {
  if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') return false;
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  var r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}`;

export function readPageScript(): string {
  const opts = { selector: INTERACTIVE_SELECTOR, attr: REF_ATTR, max: MAX_ELEMENTS };
  return `(function (opts) {
  var collect = ${COLLECT_ELEMENT_JS};
  var isVisible = ${IS_VISIBLE_JS};
  var old = document.querySelectorAll('[' + opts.attr + ']');
  for (var i = 0; i < old.length; i++) old[i].removeAttribute(opts.attr);
  var out = [];
  var all = document.querySelectorAll(opts.selector);
  for (var j = 0; j < all.length && out.length < opts.max; j++) {
    var el = all[j];
    if (!isVisible(el)) continue;
    var ref = 'e' + (out.length + 1);
    el.setAttribute(opts.attr, ref);
    out.push(collect(el, ref));
  }
  return { text: document.body ? (document.body.innerText || '') : '', elements: out };
})(${JSON.stringify(opts)})`;
}

const MARK_ATTR = 'data-ant-inspect';
export const INSPECT_MARK_SELECTOR = `[${MARK_ATTR}]`;
export const INSPECT_MARK_ATTR = MARK_ATTR;

/**
 * Every element matching `sel` in `root`, open shadow roots included: Playwright's locators pierce them, so the
 * element inspect marked may live inside a web component, where `document.querySelector` cannot see it.
 */
const DEEP_QUERY_ALL_JS = `function deepQueryAll(root, sel, out) {
  var found = root.querySelectorAll(sel);
  for (var i = 0; i < found.length; i++) out.push(found[i]);
  var all = root.querySelectorAll('*');
  for (var j = 0; j < all.length; j++) {
    if (all[j].shadowRoot) deepQueryAll(all[j].shadowRoot, sel, out);
  }
  return out;
}`;

/** Outlines the marked element in red and returns its raw facts (or null). */
export function outlineMarkedScript(): string {
  return `(function () {
  var collect = ${COLLECT_ELEMENT_JS};
  var deepQueryAll = ${DEEP_QUERY_ALL_JS};
  var el = document.querySelector('${INSPECT_MARK_SELECTOR}') || deepQueryAll(document, '${INSPECT_MARK_SELECTOR}', [])[0];
  if (!el) return null;
  el.setAttribute('data-ant-prev-outline', el.style.outline || '');
  el.setAttribute('data-ant-prev-outline-offset', el.style.outlineOffset || '');
  el.style.outline = '3px solid #ff0000';
  el.style.outlineOffset = '2px';
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
  return collect(el, '');
})()`;
}

/** Restores the outline and removes the inspection mark (open shadow roots included). */
export function clearMarkScript(): string {
  return `(function () {
  var deepQueryAll = ${DEEP_QUERY_ALL_JS};
  var els = deepQueryAll(document, '${INSPECT_MARK_SELECTOR}', []);
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.hasAttribute('data-ant-prev-outline')) {
      el.style.outline = el.getAttribute('data-ant-prev-outline');
      el.style.outlineOffset = el.getAttribute('data-ant-prev-outline-offset') || '';
      el.removeAttribute('data-ant-prev-outline');
      el.removeAttribute('data-ant-prev-outline-offset');
    }
    el.removeAttribute('${MARK_ATTR}');
  }
  return true;
})()`;
}
