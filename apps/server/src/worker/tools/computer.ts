import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { BROWSER_ACTIONS, browserActionNeedsApproval, classifyShellCommand, hostnameOf } from '@ant/shared';
import { audit, botActor } from '../../lib/audit';
import { getComputerState, recordComputerAction } from '../../services/computer-state';
import { hasActiveGrant, requireApproval } from '../approval-flow';
import type { RunContext } from '../run-context';
import { clip, fail, guarded, ok, okWithImage } from './helpers';

const OWNER_HAS_CONTROL =
  'Le propriétaire a pris la main sur l’ordinateur. N’utilise plus l’ordinateur pour l’instant : explique où tu en es et ce qu’il te reste à faire. Il te rendra la main.';

export function computerTools(rc: RunContext) {
  const { ctx, computer } = rc.deps;
  const actor = botActor(rc.bot.slug);

  async function ownerHasControl(): Promise<boolean> {
    const state = await getComputerState(ctx);
    return state.holder === 'user';
  }

  const tools = [];

  if (rc.permissions.terminal) {
    tools.push(
      tool(
        'computer_exec',
        'Exécute une commande bash sur l’ordinateur des agents (Linux, utilisateur non privilégié, dossier /workspace). Sortie tronquée au-delà de 100 Ko. Les commandes à risque (push git, ssh, envoi d’e-mail, suppression hors /workspace…) sont soumises à la validation du propriétaire.',
        {
          command: z.string().min(1).max(20_000),
          cwd: z.string().optional().describe('Dossier relatif à /workspace'),
          // Node's fetch waits at most 300 s for response headers: longer jobs go to the background.
          timeout_sec: z.number().int().min(1).max(280).optional().describe('Défaut 120 s, maximum 280 s. Pour plus long, lance en arrière-plan (nohup … > /workspace/log.txt &) puis consulte le journal.'),
        },
        async (args) =>
          guarded(async () => {
            if (await ownerHasControl()) return fail(OWNER_HAS_CONTROL);
            const risk = classifyShellCommand(args.command);
            if (risk.risky) {
              const text = await requireApproval(rc, {
                category: 'commande_risquee',
                tool: 'computer_exec',
                summary: `Commande : \`${args.command.slice(0, 1500)}\`\n\nMotif : ${risk.reasons.join(', ')}.`,
                payload: { command: args.command, cwd: args.cwd ?? null, timeoutSec: args.timeout_sec ?? 120 },
              });
              return ok(text);
            }
            await rc.setActivity('utilise le terminal');
            await recordComputerAction(ctx, rc.bot.id, `$ ${args.command.slice(0, 200)}`);
            const res = await computer.exec({ command: args.command, cwd: args.cwd, timeoutSec: args.timeout_sec ?? 120 });
            await audit(ctx.db, {
              actor,
              event: 'tool',
              runId: rc.run.id,
              tool: 'computer_exec',
              detail: { command: args.command, cwd: args.cwd, exitCode: res.exitCode, timedOut: res.timedOut },
              outcome: res.exitCode === 0 ? 'ok' : 'error',
            });
            const out = [
              `Code de sortie : ${res.exitCode ?? 'aucun'}${res.timedOut ? ' (délai dépassé)' : ''} — ${res.durationMs} ms`,
              res.stdout ? `--- stdout ---\n${res.stdout}` : '',
              res.stderr ? `--- stderr ---\n${res.stderr}` : '',
              res.truncated ? '(sortie tronquée)' : '',
            ]
              .filter(Boolean)
              .join('\n');
            return ok(clip(out));
          }),
      ),
    );
  }

  if (rc.permissions.files) {
    tools.push(
      tool(
        'file_read',
        'Lit un fichier de /workspace (numéros de ligne inclus).',
        {
          path: z.string().min(1),
          offset: z.number().int().min(1).optional().describe('Première ligne (1 = début)'),
          limit: z.number().int().min(1).max(5000).optional(),
        },
        async (args) =>
          guarded(async () => {
            if (await ownerHasControl()) return fail(OWNER_HAS_CONTROL);
            const res = await computer.readFile(args);
            if (res.binary) return ok(`${res.path} est un fichier binaire (${res.totalLines} octets).`);
            return ok(clip(`${res.path} (${res.totalLines} lignes${res.truncated ? ', extrait' : ''})\n${res.content}`));
          }),
      ),
      tool(
        'file_write',
        'Crée ou remplace un fichier dans /workspace (ou ajoute à la fin avec append).',
        { path: z.string().min(1), content: z.string().max(2_000_000), append: z.boolean().optional() },
        async (args) =>
          guarded(async () => {
            if (await ownerHasControl()) return fail(OWNER_HAS_CONTROL);
            await rc.setActivity('écrit des fichiers');
            const res = await computer.writeFile(args);
            await recordComputerAction(ctx, rc.bot.id, `écrit ${res.path}`);
            await audit(ctx.db, { actor, event: 'tool', runId: rc.run.id, tool: 'file_write', detail: { path: res.path, size: res.size, append: args.append } });
            return ok(`Écrit : ${res.path} (${res.size} octets).`);
          }),
      ),
      tool(
        'file_edit',
        'Remplace un passage exact dans un fichier de /workspace. old_string doit être unique sauf avec replace_all.',
        { path: z.string().min(1), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() },
        async (args) =>
          guarded(async () => {
            if (await ownerHasControl()) return fail(OWNER_HAS_CONTROL);
            const res = await computer.editFile({ path: args.path, oldString: args.old_string, newString: args.new_string, replaceAll: args.replace_all });
            await audit(ctx.db, { actor, event: 'tool', runId: rc.run.id, tool: 'file_edit', detail: { path: res.path, replacements: res.replacements } });
            return ok(`${res.replacements} remplacement(s) dans ${res.path}.`);
          }),
      ),
      tool('file_list', 'Liste le contenu d’un dossier de /workspace.', { path: z.string().optional() }, async (args) =>
        guarded(async () => {
          const entries = await computer.listFiles(args.path);
          if (entries.length === 0) return ok('Dossier vide.');
          return ok(clip(entries.map((e) => `${e.type === 'dir' ? '📁' : '📄'} ${e.path}${e.type === 'file' ? ` (${e.size} o)` : ''}`).join('\n')));
        }),
      ),
    );
  }

  if (rc.permissions.browser) {
    tools.push(
      tool(
        'browser',
        `Pilote le navigateur Chromium de l’ordinateur (profil persistant, connexions conservées). Actions :
- goto {url} : ouvre une page ; read : texte visible + éléments interactifs (refs e1, e2…) ; screenshot : capture d’écran
- click {ref|selector} ; type {ref|selector, text} ; press {key} ; select {ref|selector, text} ; scroll {direction} ; back
Sur les sites sensibles (paiement, messageries, réseaux sociaux, comptes), les clics et la touche Entrée sont soumis à la validation du propriétaire.`,
        {
          action: z.enum(BROWSER_ACTIONS),
          url: z.string().optional(),
          ref: z.string().optional(),
          selector: z.string().optional(),
          text: z.string().max(20_000).optional(),
          key: z.string().max(40).optional(),
          direction: z.enum(['up', 'down']).optional(),
        },
        async (args) =>
          guarded(async () => {
            if (await ownerHasControl()) return fail(OWNER_HAS_CONTROL);
            await rc.setActivity('utilise le navigateur');
            if (args.action === 'goto' && args.url) {
              const host = hostnameOf(args.url);
              if (!host || !/^https?:$/.test(new URL(args.url).protocol)) return fail('Seules les URL http(s) sont autorisées.');
            }
            if (args.action === 'click' || args.action === 'press') {
              // `screenshot` reports the current URL without re-numbering element refs (unlike `read`).
              const state = await computer.browser({ action: 'screenshot', screenshot: false });
              const needs = browserActionNeedsApproval(args.action, state.url, rc.settings.sensitiveDomains, args.key);
              if (needs && !(await hasActiveGrant(rc, state.url))) {
                const target = args.action === 'click' ? await computer.inspect({ ref: args.ref, selector: args.selector }) : null;
                const what =
                  args.action === 'click'
                    ? `Cliquer sur « ${target?.elementLabel ?? args.ref ?? args.selector ?? '?'} »`
                    : `Appuyer sur ${args.key}`;
                const text = await requireApproval(rc, {
                  category: 'navigateur_sensible',
                  tool: 'browser',
                  summary: `${what} sur ${state.url}\n\nPage : ${state.title}`,
                  payload: { ...args, expectedUrl: state.url, expectedLabel: target?.elementLabel ?? null },
                  screenshotPng: target?.screenshotPng ?? null,
                });
                return ok(text);
              }
            }
            const res = await computer.browser({ ...args, screenshot: args.action === 'screenshot' });
            await recordComputerAction(ctx, rc.bot.id, `navigateur : ${args.action}${args.url ? ` ${args.url}` : ''}`, res.url);
            await audit(ctx.db, {
              actor,
              event: 'tool',
              runId: rc.run.id,
              tool: 'browser',
              detail: { ...args, text: args.action === 'type' ? `[${args.text?.length ?? 0} caractères]` : args.text, resultUrl: res.url },
              outcome: res.ok ? 'ok' : 'error',
            });
            if (!res.ok) return fail(`Échec : ${res.error ?? 'inconnu'} (page : ${res.url})`);
            const header = `Page : ${res.title} — ${res.url}`;
            if (res.screenshotPng) return okWithImage(header, res.screenshotPng);
            if (args.action === 'read') {
              const elements = (res.elements ?? []).map((e) => `${e.ref} [${e.role}] ${e.name}`).join('\n');
              return ok(clip(`${header}\n\n--- Texte ---\n${res.text ?? ''}\n\n--- Éléments interactifs ---\n${elements}`, 40_000));
            }
            return ok(`${header}\nAction « ${args.action} » effectuée. Utilise read ou screenshot pour voir le résultat.`);
          }),
      ),
    );
  }

  return tools;
}
