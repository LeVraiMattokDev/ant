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
  isValidHHMM,
  slugify,
  type BotDTO,
  type BotInput,
  type BotPermissions,
  type EffortLevel,
} from '@ant/shared';
import { PERMISSION_KEYS, PERMISSION_LABELS } from '../../lib/labels';
import { Field, Spinner, Toggle, cx } from '../ui';
import { BotAvatar } from '../BotAvatar';

const DEFAULT_HEARTBEAT_MIN = 180;
/** Same bounds as the server (services/bots.ts): between 15 minutes and 7 days. */
const MIN_HEARTBEAT_MIN = 15;
const MAX_HEARTBEAT_MIN = 7 * 24 * 60;

const isValidInterval = (min: number) => Number.isInteger(min) && min >= MIN_HEARTBEAT_MIN && min <= MAX_HEARTBEAT_MIN;

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
  /** Interval stored for this bot (default for a new one): what is saved when the hidden field was left invalid. */
  savedIntervalMin: number;
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
    heartbeatIntervalMin: bot?.heartbeatIntervalMin ?? DEFAULT_HEARTBEAT_MIN,
    savedIntervalMin: bot?.heartbeatIntervalMin ?? DEFAULT_HEARTBEAT_MIN,
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
    // Only checked while the heartbeat is on: a value left invalid in the hidden field keeps the stored interval.
    heartbeatIntervalMin: isValidInterval(s.heartbeatIntervalMin)
      ? s.heartbeatIntervalMin
      : isValidInterval(s.savedIntervalMin)
        ? s.savedIntervalMin
        : DEFAULT_HEARTBEAT_MIN,
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
  /** Set by a submit attempt: required fields left empty are then flagged too, not only malformed ones. */
  const [showErrors, setShowErrors] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setS((prev) => ({ ...prev, [k]: v }));

  const slugValid = SLUG_RE.test(s.slug);
  const capValue = s.apiDailyCap.trim() === '' ? null : Number(s.apiDailyCap.replace(',', '.'));
  const capValid = capValue === null || (Number.isFinite(capValue) && capValue >= 0);
  // A hidden field (heartbeat or own quiet hours turned off) never blocks the form.
  const intervalValid = !s.heartbeatEnabled || isValidInterval(s.heartbeatIntervalMin);
  const quietValid = !s.quietOverride || (isValidHHMM(s.quietStart) && isValidHHMM(s.quietEnd));

  // In page order: the first one gets the focus.
  const invalid = [
    { ok: !!s.name.trim(), id: 'bot-name', label: 'nom' },
    { ok: slugValid, id: 'bot-slug', label: 'identifiant' },
    { ok: !!s.role.trim(), id: 'bot-role', label: 'rôle' },
    { ok: intervalValid, id: 'bot-interval', label: 'intervalle du heartbeat' },
    { ok: quietValid, id: isValidHHMM(s.quietStart) ? 'bot-quiet-end' : 'bot-quiet-start', label: 'heures de silence' },
    { ok: capValid, id: 'bot-cap', label: 'plafond API' },
  ].filter((f) => !f.ok);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (invalid.length > 0) {
      setShowErrors(true);
      document.getElementById(invalid[0]!.id)?.focus();
      return;
    }
    onSubmit(toBotInput(s));
  };

  const modelOptions = SELECTABLE_MODELS.includes(s.model as (typeof SELECTABLE_MODELS)[number])
    ? SELECTABLE_MODELS
    : [...SELECTABLE_MODELS, s.model];

  return (
    <form onSubmit={submit} noValidate className="max-w-2xl" aria-label={bot ? `Modifier ${bot.name}` : 'Nouveau bot'}>
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
          <Field label="Nom" htmlFor="bot-name" error={showErrors && !s.name.trim() ? 'Donne un nom au bot.' : null}>
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
          error={(s.slug || showErrors) && !slugValid ? 'Lettres minuscules, chiffres et tirets uniquement (2 à 40 caractères).' : null}
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
        <Field
          label="Rôle"
          htmlFor="bot-role"
          error={showErrors && !s.role.trim() ? 'Décris en une phrase ce que fait ce bot.' : null}
          help="Une phrase visible des autres bots, qui dit ce que fait celui-ci."
        >
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
                  id="bot-interval"
                  type="number"
                  min={MIN_HEARTBEAT_MIN}
                  max={MAX_HEARTBEAT_MIN}
                  step={5}
                  className="input w-24"
                  aria-label="Intervalle en minutes"
                  value={s.heartbeatIntervalMin}
                  onChange={(e) => set('heartbeatIntervalMin', Math.round(Number(e.target.value)))}
                />
                min
              </label>
            </div>
            {!intervalValid && <div className="help !text-danger">Entre {MIN_HEARTBEAT_MIN} minutes et 7 jours.</div>}
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
              <input
                id="bot-quiet-start"
                type="time"
                className="input w-32"
                aria-label="Début du silence"
                value={s.quietStart}
                onChange={(e) => set('quietStart', e.target.value)}
              />
              à
              <input
                id="bot-quiet-end"
                type="time"
                className="input w-32"
                aria-label="Fin du silence"
                value={s.quietEnd}
                onChange={(e) => set('quietEnd', e.target.value)}
              />
            </div>
          )}
          {!quietValid && <div className="help !text-danger">Indique une heure de début et une heure de fin.</div>}
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
      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line bg-bg px-4 py-3 md:-mx-8 md:px-8">
        {/* Never disabled for a missing field: a click says which one and moves the focus there. */}
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving && <Spinner className="size-4 text-accent-fg" />}
          {bot ? 'Enregistrer' : 'Créer le bot'}
        </button>
        {showErrors && invalid.length > 0 && (
          <span role="alert" className="text-[13px] text-danger">
            À corriger : {invalid.map((f) => f.label).join(', ')}.
          </span>
        )}
      </div>
    </form>
  );
}
