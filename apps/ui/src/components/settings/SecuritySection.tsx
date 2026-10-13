import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
import type { RecoveryCodesResponse } from '@ant/shared';
import { del, errorMessage, post } from '../../lib/api';
import { formatFull, formatShort } from '../../lib/format';
import { passwordStrength } from '../../lib/password';
import { defaultPasskeyName, passkeysSupported, registerPasskey } from '../../lib/passkey';
import { qk, usePasskeys, useSessions } from '../../lib/queries';
import { toast } from '../../lib/toast';
import { Modal, useConfirm } from '../Modal';
import { RecoveryCodes } from '../RecoveryCodes';
import { Badge, ErrorBlock, Field, Spinner } from '../ui';
import { SettingsSection } from './SettingsSection';

function describeUserAgent(ua: string | null): string {
  if (!ua) return 'Appareil inconnu';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} sur ${os}` : browser;
}

function ChangePassword() {
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const strength = passwordStrength(next);
  const change = useMutation({
    mutationFn: () => post('/api/auth/password', { current, next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setConfirm('');
      setError(null);
      // The server revokes every other session: refresh the "Sessions actives" list shown on the same page.
      void qc.invalidateQueries({ queryKey: qk.sessions });
      toast.success('Mot de passe modifié');
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setError('Les deux mots de passe ne correspondent pas.');
      return;
    }
    change.mutate();
  };
  return (
    <form onSubmit={submit} className="max-w-sm space-y-3" aria-label="Changer le mot de passe">
      <div className="text-[13px] font-semibold">Mot de passe</div>
      {error && <div className="text-[13px] text-danger">{error}</div>}
      <Field label="Mot de passe actuel" htmlFor="pw-current">
        <input id="pw-current" type="password" className="input" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="Nouveau mot de passe" htmlFor="pw-next" help={next ? strength.label : 'Au moins 14 caractères.'}>
        <input id="pw-next" type="password" className="input" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Confirmation" htmlFor="pw-confirm">
        <input id="pw-confirm" type="password" className="input" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <button type="submit" className="btn" disabled={!current || strength.score === 0 || next !== confirm || change.isPending}>
        {change.isPending && <Spinner />}
        Changer le mot de passe
      </button>
    </form>
  );
}

function Passkeys() {
  const passkeys = usePasskeys();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [name, setName] = useState(() => (typeof navigator !== 'undefined' ? defaultPasskeyName() : ''));
  const add = useMutation({
    mutationFn: () => registerPasskey(name.trim() || defaultPasskeyName()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.passkeys });
      void qc.invalidateQueries({ queryKey: qk.authState });
      toast.success('Passkey ajoutée');
    },
    onError: (err) => toast.fromError(err, 'Passkey non ajoutée'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/auth/passkeys/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.passkeys }),
    onError: (err) => toast.fromError(err, 'Suppression impossible'),
  });
  return (
    <div className="space-y-3">
      <div className="text-[13px] font-semibold">Passkeys</div>
      {passkeys.isPending ? (
        <Spinner />
      ) : passkeys.isError ? (
        <ErrorBlock error={passkeys.error} />
      ) : passkeys.data.length === 0 ? (
        <p className="text-[13px] text-subtle">Aucune passkey enregistrée.</p>
      ) : (
        <ul className="divide-y divide-line rounded-[12px] border border-line">
          {passkeys.data.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2">
              <KeyRound className="size-4 text-subtle" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium">{p.name}</div>
                <div className="text-[12px] text-subtle">
                  ajoutée {formatShort(p.createdAt)} · {p.lastUsedAt ? `utilisée ${formatShort(p.lastUsedAt)}` : 'jamais utilisée'}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-icon text-danger"
                aria-label={`Supprimer la passkey ${p.name}`}
                disabled={remove.isPending}
                onClick={() =>
                  void confirm({
                    title: 'Supprimer cette passkey ?',
                    body: `« ${p.name} » ne pourra plus servir à te connecter.`,
                    confirmLabel: 'Supprimer',
                    danger: true,
                  }).then((ok) => ok && remove.mutate(p.id))
                }
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {passkeysSupported() ? (
        <div className="flex max-w-md gap-2">
          <input className="input" aria-label="Nom de la nouvelle passkey" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <button type="button" className="btn shrink-0" onClick={() => add.mutate()} disabled={add.isPending}>
            {add.isPending ? <Spinner /> : <KeyRound className="size-4" />}
            Ajouter une passkey
          </button>
        </div>
      ) : (
        <p className="text-[12.5px] text-subtle">Ce navigateur ne gère pas les passkeys.</p>
      )}
    </div>
  );
}

function Sessions() {
  const sessions = useSessions();
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/api/auth/sessions/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.sessions });
      toast.success('Session révoquée');
    },
    onError: (err) => toast.fromError(err, 'Révocation impossible'),
  });
  return (
    <div className="space-y-3">
      <div className="text-[13px] font-semibold">Sessions actives</div>
      {sessions.isPending ? (
        <Spinner />
      ) : sessions.isError ? (
        <ErrorBlock error={sessions.error} />
      ) : (
        <ul className="divide-y divide-line rounded-[12px] border border-line">
          {sessions.data.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13.5px] font-medium">
                  {describeUserAgent(s.userAgent)}
                  {s.current && <Badge tone="success">Cette session</Badge>}
                </div>
                <div className="text-[12px] text-subtle" title={s.userAgent ?? undefined}>
                  {s.ip ?? 'IP inconnue'} · active {formatShort(s.lastSeenAt)} · ouverte {formatShort(s.createdAt)} · expire{' '}
                  <span title={formatFull(s.expiresAt)}>{formatShort(s.expiresAt)}</span>
                </div>
              </div>
              {!s.current && (
                <button type="button" className="btn btn-sm" onClick={() => revoke.mutate(s.id)} disabled={revoke.isPending}>
                  Révoquer
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RegenerateRecoveryCodes() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const regen = useMutation({
    mutationFn: () => post<RecoveryCodesResponse>('/api/auth/recovery-codes', { password }),
    onSuccess: (r) => {
      setCodes(r.recoveryCodes);
      setPassword('');
      setError(null);
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const close = () => {
    setOpen(false);
    setCodes(null);
    setPassword('');
    setError(null);
  };
  return (
    <div className="space-y-2">
      <div className="text-[13px] font-semibold">Codes de secours</div>
      <p className="text-[12.5px] text-muted">En générer de nouveaux invalide immédiatement les anciens.</p>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Régénérer les codes de secours
      </button>
      <Modal
        open={open}
        onClose={close}
        title="Nouveaux codes de secours"
        footer={
          codes ? (
            <button type="button" className="btn btn-primary" onClick={close}>
              J’ai noté mes codes
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={close}>
                Annuler
              </button>
              <button type="submit" form="regen-codes" className="btn btn-primary" disabled={!password || regen.isPending}>
                {regen.isPending && <Spinner className="size-4 text-accent-fg" />}
                Générer
              </button>
            </>
          )
        }
      >
        {codes ? (
          <RecoveryCodes codes={codes} />
        ) : (
          <form
            id="regen-codes"
            onSubmit={(e) => {
              e.preventDefault();
              regen.mutate();
            }}
            className="space-y-3"
          >
            {error && <div className="text-[13px] text-danger">{error}</div>}
            <Field label="Confirme avec ton mot de passe" htmlFor="regen-password">
              <input id="regen-password" data-autofocus type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </form>
        )}
      </Modal>
    </div>
  );
}

export function SecuritySection() {
  return (
    <SettingsSection id="securite" title="Sécurité" description="Mot de passe, passkeys, sessions ouvertes et codes de secours.">
      <ChangePassword />
      <div className="h-px bg-line" />
      <Passkeys />
      <div className="h-px bg-line" />
      <Sessions />
      <div className="h-px bg-line" />
      <RegenerateRecoveryCodes />
    </SettingsSection>
  );
}
