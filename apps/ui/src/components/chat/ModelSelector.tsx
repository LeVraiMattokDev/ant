import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown } from 'lucide-react';
import { EFFORT_LEVELS, MODEL_LABELS, type BotDTO } from '@ant/shared';
import { patch } from '../../lib/api';
import { applyBotPatch, effortDisplay, modelDisplayName, modelOptions, modelPatchFor, MODEL_HINTS, type ModelPatch } from '../../lib/models';
import { qk } from '../../lib/queries';
import { toast } from '../../lib/toast';
import { MenuLabel, MenuSeparator, Popover } from '../Popover';
import { cx } from '../ui';

/** A small starburst, the "model" glyph of the selector pill. */
export function SparkGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <path d="M8 1.6v12.8M1.6 8h12.8M3.5 3.5l9 9M12.5 3.5l-9 9" />
      </g>
    </svg>
  );
}

/** PATCH /api/bots/:id with an optimistic update of the bots cache (rolled back with a toast on error). */
export function useUpdateBotModel(botId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: ModelPatch) => patch<BotDTO>(`/api/bots/${botId}`, p),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: qk.bots });
      const previous = qc.getQueryData<BotDTO[]>(qk.bots);
      qc.setQueryData<BotDTO[]>(qk.bots, (d) => applyBotPatch(d, botId, p));
      return { previous };
    },
    onError: (err, _p, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.bots, ctx.previous);
      toast.fromError(err, 'Modèle non modifié');
    },
    onSuccess: (bot) => qc.setQueryData<BotDTO[]>(qk.bots, (d) => applyBotPatch(d, bot.id, bot)),
  });
}

function Option({ checked, onSelect, title, hint }: { checked: boolean; onSelect: () => void; title: string; hint?: string }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} tabIndex={-1} className="menu-item" onClick={onSelect}>
      <span className="min-w-0 flex-1">
        <span className={cx('block', checked && 'font-semibold')}>{title}</span>
        {hint && <span className="block text-[12px] text-subtle">{hint}</span>}
      </span>
      <Check className={cx('!size-4', checked ? '!text-fg' : 'invisible')} />
    </button>
  );
}

/** "✳ Claude Sonnet 5.5 · Moyen ▾": picks the model and effort of a bot. */
export function ModelSelector({ bot }: { bot: BotDTO }) {
  const update = useUpdateBotModel(bot.id);
  const choose = (choice: ModelPatch) => {
    const p = modelPatchFor(bot, choice);
    if (p) update.mutate(p);
  };
  return (
    <Popover
      label={`Modèle de ${bot.name}`}
      placement="bottom-end"
      className="w-[290px]"
      trigger={(p) => (
        <button
          type="button"
          {...p}
          className="flex h-8 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[13px] transition-colors hover:bg-hover"
          aria-label={`Modèle : ${modelDisplayName(bot.model)}, effort ${effortDisplay(bot.effort).toLowerCase()}. Changer`}
        >
          <SparkGlyph className="size-3.5 shrink-0 text-[#e07a4f]" />
          <span className="truncate font-semibold">
            <span className="hidden lg:inline">{modelDisplayName(bot.model)}</span>
            <span className="lg:hidden">{MODEL_LABELS[bot.model] ?? bot.model}</span>
          </span>
          <span className="hidden shrink-0 text-muted sm:inline">· {effortDisplay(bot.effort)}</span>
          <ChevronDown className="size-3.5 shrink-0 text-subtle" />
        </button>
      )}
    >
      {() => (
        <>
          <MenuLabel>Modèle de {bot.name}</MenuLabel>
          {modelOptions(bot.model).map((m) => (
            <Option key={m} checked={bot.model === m} title={modelDisplayName(m)} hint={MODEL_HINTS[m]} onSelect={() => choose({ model: m })} />
          ))}
          <MenuSeparator />
          <MenuLabel>Effort</MenuLabel>
          <div className="grid grid-cols-1">
            {EFFORT_LEVELS.map((e) => (
              <Option key={e} checked={bot.effort === e} title={effortDisplay(e)} onSelect={() => choose({ effort: e })} />
            ))}
          </div>
        </>
      )}
    </Popover>
  );
}
