import { describe, expect, it } from 'vitest';
import { describeElement, describeElements, MAX_ELEMENTS, nameOf, pageText, refSelector, roleOf, type RawElement } from '../src/browser/labels';

const raw = (over: Partial<RawElement>): RawElement => ({
  ref: 'e1',
  tag: 'button',
  type: '',
  role: '',
  ariaLabel: '',
  labelText: '',
  innerText: '',
  placeholder: '',
  value: '',
  title: '',
  ...over,
});

describe('roleOf', () => {
  it('maps tags and input types to roles, explicit role wins', () => {
    expect(roleOf(raw({ tag: 'a' }))).toBe('link');
    expect(roleOf(raw({ tag: 'button' }))).toBe('button');
    expect(roleOf(raw({ tag: 'select' }))).toBe('combobox');
    expect(roleOf(raw({ tag: 'textarea' }))).toBe('textbox');
    expect(roleOf(raw({ tag: 'input' }))).toBe('textbox');
    expect(roleOf(raw({ tag: 'input', type: 'checkbox' }))).toBe('checkbox');
    expect(roleOf(raw({ tag: 'input', type: 'SUBMIT' }))).toBe('button');
    expect(roleOf(raw({ tag: 'input', type: 'search' }))).toBe('searchbox');
    expect(roleOf(raw({ tag: 'div', role: 'tab' }))).toBe('tab');
    expect(roleOf(raw({ tag: 'div', role: 'menuitem extra' }))).toBe('menuitem');
    expect(roleOf(raw({ tag: 'div' }))).toBe('textbox');
  });
});

describe('nameOf', () => {
  it('follows aria-label > label > innerText > placeholder > value > title', () => {
    const all = { ariaLabel: 'aria', labelText: 'label', innerText: 'inner', placeholder: 'ph', value: 'val', title: 'title' };
    expect(nameOf(raw(all))).toBe('aria');
    expect(nameOf(raw({ ...all, ariaLabel: ' ' }))).toBe('label');
    expect(nameOf(raw({ ...all, ariaLabel: '', labelText: '' }))).toBe('inner');
    expect(nameOf(raw({ ...all, ariaLabel: '', labelText: '', innerText: '' }))).toBe('ph');
    expect(nameOf(raw({ title: 'only title' }))).toBe('only title');
    expect(nameOf(raw({}))).toBe('');
  });
  it('collapses whitespace and caps at 120 chars', () => {
    expect(nameOf(raw({ innerText: '  Envoyer\n\n  le   message ' }))).toBe('Envoyer le message');
    expect(nameOf(raw({ innerText: 'x'.repeat(500) }))).toHaveLength(120);
  });
  it('never exposes password values', () => {
    expect(nameOf(raw({ tag: 'input', type: 'password', value: 'hunter2' }))).toBe('');
    expect(nameOf(raw({ tag: 'input', type: 'password', value: 'hunter2', placeholder: 'Mot de passe' }))).toBe('Mot de passe');
  });
});

describe('describeElements', () => {
  it('returns { ref, role, name } and caps at 300', () => {
    expect(describeElement(raw({ ref: 'e7', tag: 'a', innerText: 'Accueil' }))).toEqual({ ref: 'e7', role: 'link', name: 'Accueil' });
    const many = Array.from({ length: 400 }, (_, i) => raw({ ref: `e${i + 1}` }));
    const out = describeElements(many);
    expect(out).toHaveLength(MAX_ELEMENTS);
    expect(out[299]!.ref).toBe('e300');
  });
});

describe('refSelector / pageText', () => {
  it('builds ref selectors and rejects injection', () => {
    expect(refSelector('e12')).toBe('[data-ant-ref="e12"]');
    expect(() => refSelector('e1"] , body [x="')).toThrow(/invalide/);
    expect(() => refSelector('12')).toThrow();
  });
  it('trims and caps page text at 50 000 chars', () => {
    expect(pageText('  a  \n\n\n\nb ')).toBe('a\n\nb');
    const long = pageText('y'.repeat(60_000));
    expect(long.startsWith('y'.repeat(50_000))).toBe(true);
    expect(long).toContain('texte tronqué');
  });
});
