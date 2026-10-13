import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { BrowserRequest, BrowserResponse, BrowserTargetInfo } from '@ant/shared';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import { agentEnv, type Config } from '../config';
import { Mutex } from '../mutex';
import {
  clearMarkScript,
  describeElements,
  INSPECT_MARK_ATTR,
  isPin,
  nameOf,
  outlineMarkedScript,
  pageText,
  PIN_ATTR,
  PIN_RE,
  pinSelector,
  readPageScript,
  refSelector,
  type RawElement,
} from './labels';

export const NAV_TIMEOUT_MS = 45_000;
export const ACTION_TIMEOUT_MS = 15_000;
export const SCROLL_PX = 700;
export const VIEWPORT = { width: 1280, height: 800 } as const;

export type InspectResult = BrowserTargetInfo & { screenshotPng?: string };

/** How an action designates its element: pin (approved node) > ref (last read) > CSS selector. */
export type BrowserTarget = Pick<BrowserRequest, 'ref' | 'selector' | 'pin'>;

export class BrowserActionError extends Error {}

function firstLines(message: string, max = 600): string {
  // Playwright errors carry a long "Call log"; keep the useful head.
  const head = message.split('\nCall log:')[0]!.trim();
  return head.length > max ? `${head.slice(0, max)}…` : head;
}

export function validateHttpUrl(raw: string | undefined): string {
  if (!raw || !raw.trim()) throw new BrowserActionError('URL requise pour « goto ».');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BrowserActionError(`URL invalide : « ${raw} ».`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrowserActionError(`Seules les URL http(s) sont autorisées (reçu « ${url.protocol} »).`);
  }
  return url.toString();
}

/**
 * Persistent Chromium (one profile, reused across actions), launched lazily and relaunched
 * if it was closed or crashed. All actions are serialised.
 */
export class BrowserManager {
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private readonly mutex = new Mutex();
  private closing = false;

  constructor(private readonly cfg: Config) {}

  /** Context alive (does not launch it). */
  get alive(): boolean {
    return this.context !== null;
  }

  /** URL of the current page, without waiting for the mutex nor launching. */
  currentUrl(): string | null {
    const pages = this.context?.pages() ?? [];
    const page = pages[pages.length - 1];
    return page ? page.url() : null;
  }

  private async launch(): Promise<BrowserContext> {
    await mkdir(this.cfg.browserProfileDir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(this.cfg.browserProfileDir, {
      headless: this.cfg.headless,
      // Headless uses the regular Chromium build ("new headless"), so the image only needs one browser.
      ...(this.cfg.headless ? { channel: 'chromium' } : {}),
      ...(this.cfg.browserExecutablePath ? { executablePath: this.cfg.browserExecutablePath } : {}),
      viewport: { ...VIEWPORT },
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        // This browser is the owner's own: it must look like a normal Chrome so sites (X, Google…) accept
        // interactive logins. navigator.webdriver stays false and no automation banner covers the page.
        '--disable-blink-features=AutomationControlled',
        // The container is the sandbox (no Chromium sandbox without user namespaces): hide the
        // « unsupported command-line flag: --no-sandbox » banner, which covers the page in the live view.
        '--test-type',
        '--lang=fr-CH',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      locale: 'fr-CH',
      ...(process.env.TZ ? { timezoneId: process.env.TZ } : {}),
      // Minimal environment: the browser (exposed to the web) never sees the service's secrets.
      env: agentEnv(this.cfg, { XDG_CONFIG_HOME: `${this.cfg.agentHome}/.config`, XDG_CACHE_HOME: `${this.cfg.agentHome}/.cache` }),
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    ctx.setDefaultTimeout(ACTION_TIMEOUT_MS);
    ctx.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    ctx.on('close', () => {
      if (this.context === ctx) this.context = null;
    });
    return ctx;
  }

  private async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (!this.launching) {
      this.launching = this.launch()
        .then((ctx) => {
          this.context = ctx;
          return ctx;
        })
        .finally(() => {
          this.launching = null;
        });
    }
    return this.launching;
  }

  /** Most recent page (popups included), a new one if none is open. */
  private async getPage(): Promise<Page> {
    const ctx = await this.getContext();
    const pages = ctx.pages().filter((p) => !p.isClosed());
    const last = pages[pages.length - 1];
    if (last) return last;
    const page = await ctx.newPage();
    return page;
  }

  private locate(page: Page, req: BrowserTarget): Locator {
    try {
      // No `.first()` for a pin: it must designate exactly one node (checked by ensureExists).
      if (req.pin !== undefined) return page.locator(pinSelector(req.pin));
      if (req.ref) return page.locator(refSelector(req.ref)).first();
    } catch (err) {
      throw new BrowserActionError((err as Error).message);
    }
    if (req.selector?.trim()) return page.locator(req.selector.trim()).first();
    throw new BrowserActionError('Élément cible requis : « ref » (issu de « read ») ou « selector ».');
  }

  private async ensureExists(locator: Locator, req: BrowserTarget): Promise<void> {
    const count = await locator.count();
    if (req.pin !== undefined) {
      // The approved node only: never another element that took its ref or its place.
      if (count === 0) throw new BrowserActionError("L'élément validé n'est plus sur la page (page rechargée ou modifiée) : action non exécutée.");
      if (count > 1) throw new BrowserActionError(`L'élément validé est ambigu (${count} éléments correspondent) : action non exécutée.`);
      return;
    }
    if (count === 0) {
      const what = req.ref ? `la référence « ${req.ref} » (refais un « read » : les références changent à chaque lecture)` : `le sélecteur « ${req.selector} »`;
      throw new BrowserActionError(`Aucun élément trouvé pour ${what}.`);
    }
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
  }

  private async snapshot(page: Page): Promise<{ url: string; title: string }> {
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  async run(req: BrowserRequest): Promise<BrowserResponse> {
    return this.mutex.run(async () => {
      let page: Page | null = null;
      try {
        page = await this.getPage();
        const extra: Partial<BrowserResponse> = {};
        switch (req.action) {
          case 'goto': {
            const url = validateHttpUrl(req.url);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
            break;
          }
          case 'read': {
            const result = (await page.evaluate(readPageScript())) as { text: string; elements: RawElement[] };
            extra.text = pageText(result.text);
            extra.elements = describeElements(result.elements);
            break;
          }
          case 'screenshot':
            break;
          case 'click': {
            const target = this.locate(page, req);
            await this.ensureExists(target, req);
            await target.click({ timeout: ACTION_TIMEOUT_MS });
            // A click may open a popup: continue on the most recent page.
            page = await this.getPage();
            await this.settle(page);
            break;
          }
          case 'type': {
            const target = this.locate(page, req);
            await this.ensureExists(target, req);
            await target.fill(req.text ?? '', { timeout: ACTION_TIMEOUT_MS });
            break;
          }
          case 'press': {
            if (!req.key?.trim()) throw new BrowserActionError('Touche requise pour « press » (ex. « Enter »).');
            if (req.pin !== undefined || req.ref || req.selector) {
              const target = this.locate(page, req);
              await this.ensureExists(target, req);
              await target.press(req.key, { timeout: ACTION_TIMEOUT_MS });
            } else {
              await page.keyboard.press(req.key);
            }
            page = await this.getPage();
            await this.settle(page);
            break;
          }
          case 'select': {
            const target = this.locate(page, req);
            await this.ensureExists(target, req);
            const wanted = (req.text ?? '').trim();
            const options = await target.evaluate((el) =>
              Array.from((el as unknown as { options?: ArrayLike<{ label: string; value: string }> }).options ?? [], (o) => ({
                label: o.label,
                value: o.value,
              })),
            );
            const match =
              options.find((o) => o.label.trim() === wanted) ??
              options.find((o) => o.value === wanted) ??
              options.find((o) => o.label.trim().toLowerCase() === wanted.toLowerCase());
            if (!match) {
              const available = options.map((o) => o.label.trim()).slice(0, 30).join(', ');
              throw new BrowserActionError(`Option « ${wanted} » introuvable (libellé ou valeur). Options : ${available || 'aucune'}.`);
            }
            await target.selectOption({ value: match.value }, { timeout: ACTION_TIMEOUT_MS });
            break;
          }
          case 'scroll': {
            const vp = page.viewportSize() ?? VIEWPORT;
            await page.mouse.move(Math.floor(vp.width / 2), Math.floor(vp.height / 2));
            await page.mouse.wheel(0, req.direction === 'up' ? -SCROLL_PX : SCROLL_PX);
            await page.waitForTimeout(300);
            break;
          }
          case 'back':
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
            break;
          default: {
            const never: never = req.action;
            throw new BrowserActionError(`Action inconnue : « ${String(never)} ».`);
          }
        }
        if (req.screenshot || req.action === 'screenshot') {
          extra.screenshotPng = (await page.screenshot({ type: 'png' })).toString('base64');
        }
        return { ok: true, ...(await this.snapshot(page)), ...extra };
      } catch (err) {
        const base = page && !page.isClosed() ? await this.snapshot(page).catch(() => ({ url: '', title: '' })) : { url: '', title: '' };
        return { ok: false, ...base, error: `Échec de « ${req.action} » : ${firstLines((err as Error).message ?? String(err))}` };
      }
    });
  }

  /**
   * Label of the targeted element + viewport screenshot with the element outlined in red (approval
   * cards), and a `pin` on that exact node: executing the approved action with it can only hit the
   * element the owner saw, even after later `read`s gave its ref to another element.
   */
  async inspect(req: BrowserTarget): Promise<InspectResult> {
    return this.mutex.run(async () => {
      const page = await this.getPage();
      let elementLabel: string | null = null;
      let pin: string | undefined;
      try {
        const target = this.locate(page, req);
        const count = await target.count();
        // A pin must still designate exactly one node, otherwise there is nothing to vouch for.
        if (req.pin !== undefined ? count === 1 : count > 0) {
          await page.evaluate(clearMarkScript());
          // An already pinned node keeps its pin: every pending approval on it stays valid. The
          // attribute is in the page's hands though: anything but a pin inspect could have issued
          // (a UUID) is overwritten — no approval can be waiting on it.
          const marked = await target.evaluate(
            (el, [markAttr, pinAttr, pinPattern, fresh]) => {
              el.setAttribute(markAttr, '1');
              const existing = el.getAttribute(pinAttr);
              if (existing !== null && new RegExp(pinPattern).test(existing)) return existing;
              el.setAttribute(pinAttr, fresh);
              return fresh;
            },
            [INSPECT_MARK_ATTR, PIN_ATTR, PIN_RE.source, randomUUID()] as const,
          );
          // Checked again here: the page's scripts can tamper with the builtins the function above uses.
          pin = isPin(marked) ? marked : undefined;
          const raw = (await page.evaluate(outlineMarkedScript())) as RawElement | null;
          if (raw) elementLabel = nameOf(raw) || raw.tag;
        }
        const screenshotPng = (await page.screenshot({ type: 'png' })).toString('base64');
        return { ...(await this.snapshot(page)), elementLabel, ...(pin ? { pin } : {}), screenshotPng };
      } catch (err) {
        if (err instanceof BrowserActionError) throw err;
        // Page in a weird state (navigating…): still answer with what we know.
        return { ...(await this.snapshot(page).catch(() => ({ url: page.url(), title: '' }))), elementLabel, ...(pin ? { pin } : {}) };
      } finally {
        await page.evaluate(clearMarkScript()).catch(() => undefined);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const ctx = this.context ?? (await this.launching?.catch(() => null)) ?? null;
    this.context = null;
    await ctx?.close().catch(() => undefined);
    this.closing = false;
  }
}
