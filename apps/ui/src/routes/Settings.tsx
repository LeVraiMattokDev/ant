import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut, Moon, Sun } from 'lucide-react';
import { isValidHHMM, isValidTimeZone, type SettingsDTO } from '@ant/shared';
import { post } from '../lib/api';
import { formatTokens } from '../lib/format';
import { useBots, useSettings } from '../lib/queries';
import { useTheme } from '../lib/theme';
import { realtime } from '../lib/ws';
import { toast } from '../lib/toast';
import { NumberField, SettingsSection } from '../components/settings/SettingsSection';
import { SensitiveDomains } from '../components/settings/SensitiveDomains';
import { SecuritySection } from '../components/settings/SecuritySection';
import { NotificationsSection } from '../components/settings/NotificationsSection';
import { settingsDiff, useUpdateSettings } from '../components/settings/useUpdateSettings';
import { ErrorBlock, Field, LoadingBlock, PageHeader, Spinner, Toggle } from '../components/ui';

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Europe/Zurich', 'Europe/Paris', 'UTC'];
  }
}

function validate(s: SettingsDTO): string | null {
  if (!isValidTimeZone(s.timezone)) return 'Fuseau horaire inconnu.';
  if (s.quietHours && (!isValidHHMM(s.quietHours.start) || !isValidHHMM(s.quietHours.end))) return 'Heures de silence invalides.';
  if (!isValidHHMM(s.digestTime)) return 'Heure du résumé invalide.';
  const ranges: [number, number, number][] = [
    [s.maxConcurrentRuns, 1, 10],
    [s.maxHandoffHops, 1, 30],
    [s.expertDailyLimit, 0, 100],
    [s.sessionRotateTokens, 20_000, 900_000],
    [s.approvalExpiryHours, 1, 720],
    [s.nudgeCooldownDays, 1, 90],
  ];
  if (ranges.some(([v, min, max]) => !Number.isFinite(v) || v < min || v > max)) return 'Certaines valeurs sont hors limites.';
  return null;
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="segmented" role="radiogroup" aria-label="Thème">
      {(['dark', 'light'] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
          onClick={() => setTheme(t)}
        >
          {t === 'dark' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
          {t === 'dark' ? 'Sombre' : 'Clair'}
        </button>
      ))}
    </div>
  );
}

function GeneralSettings({ settings }: { settings: SettingsDTO }) {
  const bots = useBots();
  const [draft, setDraft] = useState(settings);
  const update = useUpdateSettings();
  const zones = useMemo(timeZones, []);

  useEffect(() => setDraft(settings), [settings]);

  const diff = settingsDiff(settings, draft);
  const dirty = Object.keys(diff).length > 0;
  const error = validate(draft);
  const set = <K extends keyof SettingsDTO>(k: K, v: SettingsDTO[K]) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <>
      <SettingsSection title="Général" description="Fuseau horaire utilisé pour les heures de silence, les routines et le résumé.">
        <Field label="Fuseau horaire" htmlFor="tz">
          <input id="tz" className="input max-w-xs" list="tz-list" value={draft.timezone} onChange={(e) => set('timezone', e.target.value)} />
          <datalist id="tz-list">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </Field>
        <div>
          <div className="label">Thème</div>
          <ThemeToggle />
        </div>
      </SettingsSection>

      <SettingsSection title="Heures de silence" description="Pas de heartbeat ni de notification pendant ces heures. Chaque bot peut avoir les siennes.">
        <Toggle
          label="Activer les heures de silence"
          checked={!!draft.quietHours}
          onChange={(v) => set('quietHours', v ? (settings.quietHours ?? { start: '22:00', end: '07:30' }) : null)}
        />
        {draft.quietHours && (
          <div className="flex items-center gap-2 text-[13px]">
            de
            <input
              type="time"
              className="input w-32"
              aria-label="Début du silence"
              value={draft.quietHours.start}
              onChange={(e) => set('quietHours', { ...draft.quietHours!, start: e.target.value })}
            />
            à
            <input
              type="time"
              className="input w-32"
              aria-label="Fin du silence"
              value={draft.quietHours.end}
              onChange={(e) => set('quietHours', { ...draft.quietHours!, end: e.target.value })}
            />
          </div>
        )}
        <Toggle
          label="Notifier quand même les validations urgentes"
          help="Une action marquée urgente peut te réveiller."
          checked={draft.urgentPushDuringQuietHours}
          onChange={(v) => set('urgentPushDuringQuietHours', v)}
        />
      </SettingsSection>

      <SettingsSection title="Résumé quotidien" description="Ce que les bots ont fait, ce qui attend ta validation, les relances reportées et la consommation de la veille.">
        <Toggle label="Envoyer un résumé chaque jour" checked={draft.digestEnabled} onChange={(v) => set('digestEnabled', v)} />
        {draft.digestEnabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Heure" htmlFor="digest-time">
              <input id="digest-time" type="time" className="input w-32" value={draft.digestTime} onChange={(e) => set('digestTime', e.target.value)} />
            </Field>
            <Field label="Rédigé par" htmlFor="digest-bot">
              <select id="digest-bot" className="select" value={draft.digestBotId ?? ''} onChange={(e) => set('digestBotId', e.target.value || null)}>
                <option value="">Le premier bot</option>
                {(bots.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Limites" description="Garde-fous contre les boucles et la consommation excessive.">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField id="max-runs" label="Exécutions simultanées" value={draft.maxConcurrentRuns} onChange={(v) => set('maxConcurrentRuns', v)} min={1} max={10} />
          <NumberField
            id="max-hops"
            label="Transferts entre bots sans toi"
            help="Au-delà, la chaîne s’arrête et te demande."
            value={draft.maxHandoffHops}
            onChange={(v) => set('maxHandoffHops', v)}
            min={1}
            max={30}
          />
          <NumberField
            id="expert-limit"
            label="Appels au sous-agent expert par jour"
            value={draft.expertDailyLimit}
            onChange={(v) => set('expertDailyLimit', v)}
            min={0}
            max={100}
          />
          <NumberField
            id="rotate"
            label="Rotation de session au-delà de"
            help={`Résumé puis nouvelle session vers ${formatTokens(Number.isFinite(draft.sessionRotateTokens) ? draft.sessionRotateTokens : 0)} tokens.`}
            value={draft.sessionRotateTokens}
            onChange={(v) => set('sessionRotateTokens', v)}
            min={20_000}
            max={900_000}
            step={10_000}
            suffix="tokens"
          />
          <NumberField
            id="approval-expiry"
            label="Expiration des validations"
            value={draft.approvalExpiryHours}
            onChange={(v) => set('approvalExpiryHours', v)}
            min={1}
            max={720}
            suffix="heures"
          />
          <NumberField
            id="nudge-cooldown"
            label="Délai avant de reparler d’une relance ignorée"
            value={draft.nudgeCooldownDays}
            onChange={(v) => set('nudgeCooldownDays', v)}
            min={1}
            max={90}
            suffix="jours"
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Domaines sensibles"
        description="Sur ces sites, un clic ou la touche Entrée dans le navigateur des agents demande ta validation, avec capture d’écran."
      >
        <SensitiveDomains value={draft.sensitiveDomains} onChange={(v) => set('sensitiveDomains', v)} />
      </SettingsSection>

      {dirty && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t border-line bg-surface px-4 py-3 md:-mx-8 md:px-8">
          <span className="text-[13px] text-muted">{error ?? 'Modifications non enregistrées'}</span>
          <div className="ml-auto flex gap-2">
            <button type="button" className="btn" onClick={() => setDraft(settings)}>
              Annuler
            </button>
            <button type="button" className="btn btn-primary" disabled={!!error || update.isPending} onClick={() => update.mutate(diff)}>
              {update.isPending && <Spinner className="size-4 text-accent-fg" />}
              Enregistrer
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => post('/api/auth/logout'),
    onSettled: () => {
      realtime.stop();
      qc.clear();
      navigate('/login', { replace: true });
    },
    onError: (err) => toast.fromError(err, 'Déconnexion incomplète'),
  });

  return (
    <>
      <PageHeader
        title="Réglages"
        actions={
          <button type="button" className="btn" onClick={() => logout.mutate()} disabled={logout.isPending}>
            {logout.isPending ? <Spinner /> : <LogOut className="size-4" />}
            Se déconnecter
          </button>
        }
      />
      <div className="scroll-y flex-1 px-4 md:px-8">
        <div className="max-w-5xl">
          {settings.isPending ? (
            <LoadingBlock />
          ) : settings.isError ? (
            <ErrorBlock error={settings.error} onRetry={() => void settings.refetch()} />
          ) : (
            <GeneralSettings settings={settings.data} />
          )}
          <NotificationsSection />
          <SecuritySection />
        </div>
      </div>
    </>
  );
}
