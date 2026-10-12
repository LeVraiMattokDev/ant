import { useState, type FormEvent } from 'react';
import {
  DEFAULT_BOT_EFFORT,
  DEFAULT_BOT_MODEL,
  DEFAULT_BOT_PERMISSIONS,
  EFFORT_LABELS,
  EFFORT_LEVELS,
  MODEL_LABELS,
  SELECTABLE_MODELS,
  SLUG_RE,
  slugify,
  type BotDTO,
  type BotInput,
  type BotPermissions,
  type EffortLevel,
} from '@ant/shared';
import { PERMISSION_KEYS, PERMISSION_LABELS } from '../../lib/labels';
import { Field, Spinner, Toggle, cx } from '../ui';
import { BotAvatar } from '../BotAvatar';

const HEARTBEAT_PRESETS = [
  { min: 60, label: '1 h' },
  { min: 180, label: '3 h' },
  { min: 360, label: '6 h' },
  { min: 720, label: '12 h' },
  { min: 1440, label: '24 h' },
];

interface FormState {
  name: string;
  slug: string;
  slugTouched: boolean;
  avatar: string;
  role: string;
  instructions: string;
  model: string;
  effort: EffortLevel;
  permissions: BotPermissions;
  heartbeatEnabled: boolean;
  heartbeatIntervalMin: number;
  quietOverride: boolean;
  quietStart: string;
  quietEnd: string;
  apiDailyCap: string;
  paused: boolean;
}

function initialState(bot: BotDTO | undefined): FormState {
  return {
    name: bot?.name ?? '',
    slug: bot?.slug ?? '',
    slugTouched: !!bot,
    avatar: bot?.avatar ?? '🐜',
    role: bot?.role ?? '',
    instructions: bot?.instructions ?? '',
    model: bot?.model ?? DEFAULT_BOT_MODEL,
    effort: bot?.effort ?? DEFAULT_BOT_EFFORT,
    permissions: { ...DEFAULT_BOT_PERMISSIONS, ...bot?.permissions },
    heartbeatEnabled: bot?.heartbeatEnabled ?? true,
    heartbeatIntervalMin: bot?.heartbeatIntervalMin ?? 180,
    quietOverride: !!bot?.quietHours,
    quietStart: bot?.quietHours?.start ?? '22:00',
    quietEnd: bot?.quietHours?.end ?? '07:30',
    apiDailyCap: bot?.apiDailyCapUsd != null ? String(bot.apiDailyCapUsd) : '',
    paused: bot?.paused ?? false,
  };
}

export function toBotInput(s: FormState): BotInput {
  const cap = s.apiDailyCap.trim() === '' ? null : Number(s.apiDailyCap.replace(',', '.'));
  return {
    name: s.name.trim(),
    slug: s.slug.trim(),
    avatar: s.avatar.trim(),
    role: s.role.trim(),
    instructions: s.instructions,
    model: s.model,
    effort: s.effort,
    permissions: s.permissions,
    heartbeatEnabled: s.heartbeatEnabled,
    heartbeatIntervalMin: s.heartbeatIntervalMin,
    quietHours: s.quietOverride ? { start: s.quietStart, end: s.quietEnd } : null,
    apiDailyCapUsd: cap !== null && Number.isFinite(cap) ? cap : null,
    paused: s.paused,
  };
}

function Section({ title, children, description }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line py-5 first:pt-0 last:border-0">
      <h2 className="text-[14px] font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>}
      <div className="mt-3 space-y-4">{children}</div>
    </section>
  );
}

export function BotForm({
  bot,
  onSubmit,
  saving,
  error,
}: {
  bot?: BotDTO;
  onSubmit: (input: BotInput) => void;
  saving: boolean;
  error: string | null;
}) {
  const [s, setS] = useState<FormState>(() => initialState(bot));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setS((prev) => ({ ...prev, [k]: v }));

  const slugValid = SLUG_RE.test(s.slug);
  const capValue = s.apiDailyCap.trim() === '' ? null : Number(s.apiDailyCap.replace(',', '.'));
  const capValid = capValue === null || (Number.isFinite(capValue) && capValue >= 0);
  const intervalValid = Number.isInteger(s.heartbeatIntervalMin) && s.heartbeatIntervalMin >= 15;
  const valid = s.name.trim() && s.role.trim() && slugValid && capValid && intervalValid;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onSubmit(toBotInput(s));
  };

  const modelOptions = SELECTABLE_MODELS.includes(s.model as (typeof SELECTABLE_MODELS)[number])
    ? SELECTABLE_MODELS
    : [...SELECTABLE_MODELS, s.model];

  return (
    <form onSubmit={submit} className="max-w-2xl" aria-label={bot ? `Modifier ${bot.name}` : 'Nouveau bot'}>
      <Section title="Identité">
        <div className="grid gap-4 sm:grid-cols-[150px_1fr]">
          <Field label="Avatar" htmlFor="bot-avatar" help="🐜 : avatar généré. Sinon, un emoji.">
            <div className="flex items-center gap-2.5">
              <BotAvatar bot={{ slug: s.slug || slugify(s.name) || 'bot', name: s.name, avatar: s.avatar }} size={36} label="Aperçu de l’avatar" />
              <input
                id="bot-avatar"
                className="input w-16 text-center text-[18px]"
                value={s.avatar}
                maxLength={8}
                onChange={(e) => set('avatar', e.target.value)}
              />
            </div>
          </Field>
          <Field label="Nom" htmlFor="bot-name">
            <input
              id="bot-name"
              className="input"
              required
              maxLength={60}
              value={s.name}
              onChange={(e) => {
                const name = e.target.value;
                setS((prev) => ({ ...prev, name, slug: prev.slugTouched ? prev.slug : slugify(name) }));
              }}
            />
          </Field>
        </div>
        <Field
          label="Identifiant (@mention)"
          htmlFor="bot-slug"
          error={s.slug && !slugValid ? 'Lettres minuscules, chiffres et tirets uniquement (2 à 40 caractères).' : null}
          help="Utilisé pour mentionner le bot : @dev, @recherche…"
        >
          <div className="flex items-center">
            <span className="flex h-8 items-center rounded-l-[10px] border border-r-0 border-line-strong bg-raised px-2 text-muted">@</span>
            <input
              id="bot-slug"
              className="input rounded-l-none"
              required
              maxLength={40}
              value={s.slug}
              onChange={(e) => setS((prev) => ({ ...prev, slug: e.target.value.toLowerCase(), slugTouched: true }))}
            />
          </div>
        </Field>
        <Field label="Rôle" htmlFor="bot-role" help="Une phrase visible des autres bots, qui dit ce que fait celui-ci.">
          <input id="bot-role" className="input" required maxLength={200} value={s.role} onChange={(e) => set('role', e.target.value)} />
        </Field>
        <Field label="Instructions" htmlFor="bot-instructions" help="Comment il travaille, ce qu’il doit éviter, son ton. Markdown accepté.">
          <textarea
            id="bot-instructions"
            className="textarea mono min-h-[220px] text-[13px]"
            value={s.instructions}
            onChange={(e) => set('instructions', e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Modèle">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Modèle" htmlFor="bot-model">
            <select id="bot-model" className="select" value={s.model} onChange={(e) => set('model', e.target.value)}>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABELS[m] ?? m}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effort" htmlFor="bot-effort" help="Plus d’effort = réponses plus réfléchies, plus lentes et plus coûteuses.">
            <select id="bot-effort" className="select" value={s.effort} onChange={(e) => set('effort', e.target.value as EffortLevel)}>
              {EFFORT_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {EFFORT_LABELS[l].charAt(0).toUpperCase() + EFFORT_LABELS[l].slice(1)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      <Section title="Permissions" description="Les actions sensibles passent toujours par une validation, quelles que soient ces permissions.">
        <div className="divide-y divide-line rounded-[12px] border border-line px-3">
          {PERMISSION_KEYS.map((k) => (
            <Toggle
              key={k}
              label={PERMISSION_LABELS[k].label}
              help={PERMISSION_LABELS[k].help}
              checked={s.permissions[k]}
              onChange={(v) => set('permissions', { ...s.permissions, [k]: v })}
            />
          ))}
        </div>
      </Section>

      <Section title="Proactivité" description="Le heartbeat réveille le bot pour qu’il fasse le point et te propose des relances.">
        <Toggle label="Heartbeat" checked={s.heartbeatEnabled} onChange={(v) => set('heartbeatEnabled', v)} />
        {s.heartbeatEnabled && (
          <div>
            <div className="label">Intervalle</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {HEARTBEAT_PRESETS.map((p) => (
                <button
                  key={p.min}
                  type="button"
                  aria-pressed={s.heartbeatIntervalMin === p.min}
                  onClick={() => set('heartbeatIntervalMin', p.min)}
                  className={cx('btn btn-sm', s.heartbeatIntervalMin === p.min && 'border-accent bg-accent-soft text-accent-text')}
                >
                  {p.label}
                </button>
              ))}
              <label className="ml-2 flex items-center gap-1.5 text-[13px] text-muted">
                ou
                <input
                  type="number"
                  min={15}
                  step={5}
                  className="input w-24"
                  aria-label="Intervalle en minutes"
                  value={s.heartbeatIntervalMin}
                  onChange={(e) => set('heartbeatIntervalMin', Math.round(Number(e.target.value)))}
                />
                min
              </label>
            </div>
            {!intervalValid && <div className="help !text-danger">Au moins 15 minutes.</div>}
          </div>
        )}
        <div>
          <div className="label">Heures de silence</div>
          <div className="flex flex-col gap-1.5 text-[13.5px]">
            <label className="flex items-center gap-2">
              <input type="radio" name="quiet" className="accent-[var(--ant-accent)]" checked={!s.quietOverride} onChange={() => set('quietOverride', false)} />
              Utiliser les heures de silence globales
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="quiet" className="accent-[var(--ant-accent)]" checked={s.quietOverride} onChange={() => set('quietOverride', true)} />
              Heures propres à ce bot
            </label>
          </div>
          {s.quietOverride && (
            <div className="mt-2 flex items-center gap-2 text-[13px]">
              de
              <input type="time" className="input w-28" aria-label="Début du silence" value={s.quietStart} onChange={(e) => set('quietStart', e.target.value)} />
              à
              <input type="time" className="input w-28" aria-label="Fin du silence" value={s.quietEnd} onChange={(e) => set('quietEnd', e.target.value)} />
            </div>
          )}
        </div>
      </Section>

      <Section title="Budget et état">
        <Field
          label="Plafond API quotidien pour ce bot ($)"
          htmlFor="bot-cap"
          error={capValid ? null : 'Montant invalide.'}
          help="Vide = seulement les plafonds globaux."
        >
          <input
            id="bot-cap"
            className="input w-40"
            inputMode="decimal"
            placeholder="aucun"
            value={s.apiDailyCap}
            onChange={(e) => set('apiDailyCap', e.target.value)}
          />
        </Field>
        <Toggle
          label="En pause"
          help="Un bot en pause ne répond plus, ne fait plus de heartbeat et n’exécute plus ses routines."
          checked={s.paused}
          onChange={(v) => set('paused', v)}
        />
      </Section>

      {error && (
        <div role="alert" className="mb-3 rounded-[8px] border border-danger/40 bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error}
        </div>
      )}
      <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-line bg-bg px-4 py-3 md:-mx-8 md:px-8">
        <button type="submit" className="btn btn-primary" disabled={!valid || saving}>
          {saving && <Spinner className="size-4 text-accent-fg" />}
          {bot ? 'Enregistrer' : 'Créer le bot'}
        </button>
      </div>
    </form>
  );
}
