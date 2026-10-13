import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound } from 'lucide-react';
import type { RecoveryCodesResponse, SetupStartResponse } from '@ant/shared';
import { ApiError, errorMessage, post } from '../lib/api';
import { qk, useAuthState } from '../lib/queries';
import { MIN_PASSWORD_LENGTH, passwordStrength } from '../lib/password';
import { defaultPasskeyName, passkeysSupported, registerPasskey } from '../lib/passkey';
import { copyText } from '../lib/clipboard';
import { AuthLayout, FormError } from '../components/AuthLayout';
import { QrCode } from '../components/QrCode';
import { RecoveryCodes } from '../components/RecoveryCodes';
import { LoadingBlock, Spinner, cx } from '../components/ui';

type Step = 'credentials' | 'totp' | 'codes' | 'passkey';
const STORAGE_KEY = 'ant-setup-totp';

function loadPendingTotp(): SetupStartResponse | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SetupStartResponse) : null;
  } catch {
    return null;
  }
}

function StrengthMeter({ password }: { password: string }) {
  const s = passwordStrength(password);
  const colors = ['bg-danger', 'bg-warning', 'bg-accent', 'bg-success'];
  return (
    <div className="mt-2">
      <div className="flex gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cx('h-1 flex-1 rounded-full', password && i <= s.score ? colors[s.score] : 'bg-raised')} />
        ))}
      </div>
      <div className="help" aria-live="polite">
        {password ? s.label : `Au moins ${MIN_PASSWORD_LENGTH} caractères. Une phrase de plusieurs mots est idéale.`}
      </div>
    </div>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: 'credentials', label: 'Mot de passe' },
    { id: 'totp', label: 'Authentification' },
    { id: 'codes', label: 'Codes de secours' },
    { id: 'passkey', label: 'Passkey' },
  ];
  const idx = steps.findIndex((s) => s.id === step);
  return (
    <ol className="mb-6 flex gap-1" aria-label="Étapes">
      {steps.map((s, i) => (
        <li key={s.id} className="flex-1" aria-current={i === idx ? 'step' : undefined}>
          <div className={cx('h-0.5 rounded-full', i <= idx ? 'bg-accent' : 'bg-line')} />
          <div className={cx('mt-1.5 text-[11px]', i === idx ? 'text-fg' : 'text-subtle')}>{s.label}</div>
        </li>
      ))}
    </ol>
  );
}

export function SetupPage() {
  const auth = useAuthState();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('credentials');
  const [started, setStarted] = useState(false);
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [totp, setTotp] = useState<SetupStartResponse | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [passkeyName, setPasskeyName] = useState('');
  // Adding a passkey asks for the password again: the one chosen above is kept in memory for that last step only.
  // After a reload in the middle of the setup it is gone, and the passkey step asks for it.
  const [enrolPassword, setEnrolPassword] = useState('');
  const [enrolPasswordKept, setEnrolPasswordKept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  // Resume an interrupted enrolment (page reloaded after the password step).
  useEffect(() => {
    if (started || !auth.data?.enrolmentPending) return;
    const pending = loadPendingTotp();
    if (pending) {
      setTotp(pending);
      setStep('totp');
    }
    setStarted(true);
  }, [auth.data?.enrolmentPending, started]);

  useEffect(() => {
    if (typeof navigator !== 'undefined') setPasskeyName(defaultPasskeyName());
  }, []);

  if (auth.isPending) return <LoadingBlock label="Connexion à Ant…" />;
  const inFlow = step !== 'credentials';
  if (!inFlow && auth.data && !auth.data.setupRequired && !auth.data.enrolmentPending) {
    return <Navigate to={auth.data.authenticated ? '/' : '/login'} replace />;
  }

  const strength = passwordStrength(password);
  const canSubmitCredentials = token.trim() && strength.score > 0 && password === confirm && !busy;

  const submitCredentials = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('Les deux mots de passe ne correspondent pas.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await post<SetupStartResponse>('/api/auth/setup', { setupToken: token.trim(), password });
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(res));
      } catch {
        /* resume after reload will not be possible */
      }
      setTotp(res);
      setEnrolPassword(password);
      setEnrolPasswordKept(true);
      setPassword('');
      setConfirm('');
      setStep('totp');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitTotp = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await post<RecoveryCodesResponse>('/api/auth/setup/totp', { code: code.replace(/\s/g, '') });
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      setCodes(res.recoveryCodes);
      setStep('codes');
    } catch (err) {
      setCode('');
      if (err instanceof ApiError && err.status === 401) {
        // The enrolment session (10 minutes) has expired: this secret can no longer be confirmed. The setup
        // token stays valid until the end of the setup, so starting over issues a new secret.
        try {
          sessionStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
        setTotp(null);
        setStep('credentials');
        setError(
          'Étape expirée (10 minutes) : recommence avec le jeton d’initialisation et ton mot de passe. Supprime l’entrée « Ant » ajoutée dans ton application, un nouveau QR code va être généré.',
        );
        void qc.invalidateQueries({ queryKey: qk.authState });
        return;
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setEnrolPassword('');
    setEnrolPasswordKept(false);
    await qc.invalidateQueries({ queryKey: qk.authState });
    navigate('/', { replace: true });
  };

  const addPasskey = async (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await registerPasskey(passkeyName.trim() || defaultPasskeyName(), enrolPassword);
      await finish();
    } catch (err) {
      // A wrong password (typed after a reload) is asked again.
      if (err instanceof ApiError && err.status === 401) {
        setEnrolPassword('');
        setEnrolPasswordKept(false);
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const titles: Record<Step, { title: string; subtitle: string }> = {
    credentials: {
      title: 'Initialisation',
      subtitle: 'Premier lancement : saisis le jeton d’initialisation (valeur de SETUP_TOKEN dans ton fichier .env), puis choisis ton mot de passe.',
    },
    totp: {
      title: 'Application d’authentification',
      subtitle: 'Scanne ce code avec ton application (1Password, Aegis, Google Authenticator…), puis saisis le code à 6 chiffres.',
    },
    codes: {
      title: 'Codes de secours',
      subtitle: 'Ils te permettent de te connecter si tu perds ton téléphone. Ils ne seront plus affichés.',
    },
    passkey: {
      title: 'Passkey (facultatif)',
      subtitle: 'Une passkey te connecte en un geste (Face ID, Touch ID, Windows Hello, clé de sécurité), sans mot de passe ni code.',
    },
  };

  return (
    <AuthLayout title={titles[step].title} subtitle={titles[step].subtitle}>
      <StepIndicator step={step} />
      <div className="space-y-4">
        <FormError message={error} />

        {step === 'credentials' && (
          <form onSubmit={submitCredentials} className="space-y-4">
            {auth.data?.enrolmentPending && (
              <div className="rounded-[8px] border border-warning/40 bg-warning-soft px-3 py-2 text-[13px]">
                L’initialisation a été interrompue avant la configuration du code. Recommence avec le jeton d’initialisation.
              </div>
            )}
            <div>
              <label className="label" htmlFor="token">
                Jeton d’initialisation
              </label>
              <input
                id="token"
                className="input mono"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                required
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <div className="help">
                C’est la valeur de <span className="mono">SETUP_TOKEN</span> dans <span className="mono">.env</span> (
                <span className="mono">grep SETUP_TOKEN .env</span>). Si elle est vide, Ant en génère un, visible avec{' '}
                <span className="mono">docker compose logs web</span>. Il ne sert qu’une fois.
              </div>
            </div>
            <div>
              <label className="label" htmlFor="new-password">
                Mot de passe
              </label>
              <input
                id="new-password"
                type="password"
                className="input"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <StrengthMeter password={password} />
            </div>
            <div>
              <label className="label" htmlFor="confirm-password">
                Confirmation
              </label>
              <input
                id="confirm-password"
                type="password"
                className="input"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {confirm && confirm !== password && <div className="help !text-danger">Les deux mots de passe ne correspondent pas.</div>}
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={!canSubmitCredentials}>
              {busy && <Spinner className="size-4 text-accent-fg" />}
              Continuer
            </button>
          </form>
        )}

        {step === 'totp' && totp && (
          <form onSubmit={submitTotp} className="space-y-4">
            <div className="flex justify-center rounded-[12px] border border-line bg-surface p-4">
              <QrCode text={totp.totpUri} label="QR code de configuration de l’authentification à deux facteurs" />
            </div>
            <div>
              <div className="label">Ou saisis cette clé manuellement</div>
              <div className="flex items-center gap-2">
                <code className="mono flex-1 break-all rounded-[8px] border border-line bg-bg px-2 py-1.5">{totp.totpSecret}</code>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    void copyText(totp.totpSecret).then((ok) => {
                      setSecretCopied(ok);
                      setTimeout(() => setSecretCopied(false), 1500);
                    })
                  }
                >
                  <Copy className="size-3.5" />
                  {secretCopied ? 'Copiée' : 'Copier'}
                </button>
              </div>
            </div>
            <div>
              <label className="label" htmlFor="totp-code">
                Code à 6 chiffres
              </label>
              <input
                id="totp-code"
                className="input mono tracking-[0.15em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}"
                maxLength={7}
                required
                autoFocus
                placeholder="123 456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={code.replace(/\s/g, '').length !== 6 || busy}>
              {busy && <Spinner className="size-4 text-accent-fg" />}
              Vérifier
            </button>
          </form>
        )}

        {step === 'totp' && !totp && (
          <button type="button" className="btn w-full" onClick={() => setStep('credentials')}>
            Recommencer l’initialisation
          </button>
        )}

        {step === 'codes' && (
          <div className="space-y-4">
            <RecoveryCodes codes={codes} />
            <label className="flex items-start gap-2 text-[13.5px]">
              <input type="checkbox" className="mt-0.5 accent-[var(--ant-accent)]" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
              J’ai noté mes codes dans un endroit sûr (gestionnaire de mots de passe, papier).
            </label>
            <button
              type="button"
              className="btn btn-primary w-full"
              disabled={!acknowledged}
              onClick={() => (passkeysSupported() ? setStep('passkey') : void finish())}
            >
              J’ai noté mes codes
            </button>
          </div>
        )}

        {step === 'passkey' && (
          <form onSubmit={(e) => void addPasskey(e)} className="space-y-4">
            <div>
              <label className="label" htmlFor="passkey-name">
                Nom de cet appareil
              </label>
              <input id="passkey-name" className="input" value={passkeyName} onChange={(e) => setPasskeyName(e.target.value)} maxLength={60} />
            </div>
            {!enrolPasswordKept && (
              <div>
                <label className="label" htmlFor="passkey-password">
                  Ton mot de passe
                </label>
                <input
                  id="passkey-password"
                  type="password"
                  className="input"
                  autoComplete="current-password"
                  value={enrolPassword}
                  onChange={(e) => setEnrolPassword(e.target.value)}
                />
                <div className="help">Celui choisi à la première étape : il confirme que c’est bien toi qui ajoutes cette passkey.</div>
              </div>
            )}
            <button type="submit" className="btn btn-primary w-full" disabled={busy || !enrolPassword}>
              {busy ? <Spinner className="size-4 text-accent-fg" /> : <KeyRound className="size-4" />}
              Ajouter une passkey
            </button>
            <button type="button" className="btn btn-ghost w-full" onClick={() => void finish()} disabled={busy}>
              Plus tard, ouvrir Ant
            </button>
          </form>
        )}
      </div>
    </AuthLayout>
  );
}
