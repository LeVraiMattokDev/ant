import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ApprovalCategory } from '@ant/shared';
import { requireApproval } from '../approval-flow';
import type { RunContext } from '../run-context';
import { guarded, ok } from './helpers';

const CATEGORIES: [ApprovalCategory, ...ApprovalCategory[]] = [
  'message_externe',
  'publication',
  'achat',
  'suppression',
  'compte',
  'irreversible',
];

export function approvalTools(rc: RunContext) {
  return [
    tool(
      'request_approval',
      'Demande au propriétaire de valider une action irréversible ou sensible AVANT de la faire (envoi en son nom, publication, achat, suppression, modification de compte). Si elle concerne un site, indique son domaine : une fois validée, tu pourras agir sur ce site pendant 30 minutes.',
      {
        category: z.enum(CATEGORIES),
        title: z.string().min(3).max(150).describe('Action en quelques mots'),
        summary: z.string().min(10).max(4000).describe('Ce que tu vas faire exactement, pour qui, avec quel contenu'),
        domain: z.string().max(253).optional().describe('Domaine du site concerné, ex. linkedin.com'),
        urgent: z.boolean().optional(),
      },
      async (args) =>
        guarded(async () =>
          ok(
            await requireApproval(rc, {
              category: args.category,
              tool: 'request_approval',
              title: args.title,
              summary: args.summary,
              payload: { domain: args.domain ?? null, title: args.title },
              urgent: args.urgent,
            }),
          ),
        ),
    ),
  ];
}
