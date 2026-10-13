/**
 * Risk classification for actions on the agents' computer.
 * This is a safety net, not a guarantee: structured connectors (v2) allow exhaustive checks.
 */

export type ApprovalCategory =
  | 'message_externe'
  | 'publication'
  | 'achat'
  | 'suppression'
  | 'compte'
  | 'commande_risquee'
  | 'navigateur_sensible'
  | 'irreversible';

export const APPROVAL_CATEGORY_LABELS: Record<ApprovalCategory, string> = {
  message_externe: 'Envoyer un message en ton nom',
  publication: 'Publier',
  achat: 'Acheter / payer',
  suppression: 'Supprimer',
  compte: 'Modifier un compte',
  commande_risquee: 'Commande système à risque',
  navigateur_sensible: 'Action sur un site sensible',
  irreversible: 'Action irréversible',
};

interface CommandRule {
  re: RegExp;
  reason: string;
}

const COMMAND_RULES: CommandRule[] = [
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, reason: 'exécution d’un script téléchargé' },
  { re: /\bmkfs(\.\w+)?\b/, reason: 'formatage de système de fichiers' },
  { re: /\bdd\s+[^\n]*\bof=\/dev\//, reason: 'écriture brute sur un périphérique' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, reason: 'arrêt de la machine' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: 'fork bomb' },
  { re: /\bchmod\s+(-R\s+)?[0-7]*7{2}[0-7]?\s+\/(\s|$)/, reason: 'permissions ouvertes sur la racine' },
  { re: /\bgit\s+push\b[^\n]*(--force|-f\b|--mirror|--delete)/, reason: 'push git destructif' },
  { re: /\bgit\s+push\b/, reason: 'publication de code (git push)' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/, reason: 'publication d’un paquet' },
  { re: /\b(ssh|scp|sftp|rsync\s+[^\n]*@)\b/, reason: 'connexion vers une autre machine' },
  { re: /\b(sendmail|mailx?|mutt|swaks)\b/, reason: 'envoi d’e-mail' },
  { re: /\bcrontab\s+-r\b/, reason: 'suppression de la crontab' },
];

/** Paths an agent may delete freely. */
const SAFE_DELETE_PREFIXES = ['/workspace/', '/tmp/'];

function deletesOutsideWorkspace(command: string): boolean {
  const re = /\brm\s+((?:-[a-zA-Z]+\s+)*)([^;&|\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const flags = m[1] ?? '';
    const recursive = /-[a-zA-Z]*[rR]/.test(flags);
    const targets = (m[2] ?? '').trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
    for (const t of targets) {
      const unquoted = t.replace(/^['"]|['"]$/g, '');
      if (unquoted === '/' || unquoted === '/*' || unquoted.startsWith('~') || unquoted.includes('..') || unquoted.startsWith('$')) return true;
      if (unquoted.startsWith('/') && !SAFE_DELETE_PREFIXES.some((p) => unquoted.startsWith(p))) return true;
      if (recursive && (unquoted === '*' || unquoted === '.' || unquoted === './*')) return true;
    }
  }
  return false;
}

export function classifyShellCommand(command: string): { risky: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const rule of COMMAND_RULES) {
    if (rule.re.test(command) && !reasons.includes(rule.reason)) reasons.push(rule.reason);
  }
  if (deletesOutsideWorkspace(command)) reasons.push('suppression hors de /workspace ou suppression large');
  return { risky: reasons.length > 0, reasons };
}

export const DEFAULT_SENSITIVE_DOMAINS: readonly string[] = [
  // paiement / banques
  'paypal.com', 'stripe.com', 'twint.ch', 'revolut.com', 'wise.com', 'postfinance.ch', 'ubs.com', 'raiffeisen.ch',
  'credit-suisse.com', 'bcv.ch', 'bcge.ch', 'zkb.ch', 'neon-free.ch', 'yuh.com',
  // achats
  'amazon.com', 'amazon.fr', 'amazon.de', 'ebay.com', 'galaxus.ch', 'digitec.ch', 'ricardo.ch', 'tutti.ch', 'aliexpress.com',
  'booking.com', 'airbnb.com',
  // messageries / e-mail
  'mail.google.com', 'gmail.com', 'outlook.live.com', 'outlook.office.com', 'mail.proton.me', 'proton.me',
  'web.whatsapp.com', 'whatsapp.com', 'web.telegram.org', 'discord.com', 'slack.com', 'messenger.com',
  // réseaux sociaux / publication
  'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'threads.net', 'bsky.app', 'reddit.com',
  'youtube.com', 'tiktok.com', 'medium.com',
  // comptes / code
  'accounts.google.com', 'myaccount.google.com', 'appleid.apple.com', 'account.microsoft.com', 'github.com', 'gitlab.com',
  'console.anthropic.com', 'platform.claude.com', 'claude.ai',
];

export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when the URL's host equals or is a subdomain of one of `domains`. */
export function isSensitiveUrl(url: string, domains: readonly string[]): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return domains.some((d) => {
    const dom = d.trim().toLowerCase().replace(/^\*\./, '');
    return dom.length > 0 && (host === dom || host.endsWith(`.${dom}`));
  });
}

export const BROWSER_ACTIONS = ['goto', 'read', 'screenshot', 'scroll', 'back', 'click', 'type', 'press', 'select'] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];

/**
 * Keys that only move the focus or scroll. Every other key can commit something on a sensitive site:
 * Enter in any spelling (NumpadEnter, "\r", "\n"), Space on a focused button, chords such as
 * Control+Enter (send / post shortcut on Gmail, X, Proton…) and single-letter site shortcuts.
 */
const NAVIGATION_KEYS = new Set([
  'tab',
  'shift+tab',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'pageup',
  'pagedown',
  'home',
  'end',
  'escape',
]);

/** True when pressing `key` cannot submit, send or activate anything. */
export function isNavigationKey(key: string | undefined): boolean {
  if (!key) return false;
  // Exact match after dropping spaces around "+" only: " " (Space) must not normalise into a navigation key.
  return NAVIGATION_KEYS.has(key.replace(/\s*\+\s*/g, '+').trim().toLowerCase());
}

/**
 * On a sensitive site, actions that can commit something need approval: a click, and any key press
 * other than pure navigation (allowlist, so new shortcuts cannot slip through).
 * Typing into a field or selecting an option commits nothing by itself (it fills the field without
 * key events), so it stays free; the click or key that sends is what gets validated.
 */
export function browserActionNeedsApproval(action: BrowserAction, url: string, domains: readonly string[], key?: string): boolean {
  if (!isSensitiveUrl(url, domains)) return false;
  if (action === 'click') return true;
  if (action === 'press') return !isNavigationKey(key);
  return false;
}
