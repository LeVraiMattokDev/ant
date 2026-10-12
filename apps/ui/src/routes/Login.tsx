import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { errorMessage, post } from '../lib/api';
import { qk, useAuthState } from '../lib/queries';
import { loginWithPasskey, passkeysSupported } from '../lib/passkey';
import { AuthLayout, FormError } from '../components/AuthLayout';
import { LoadingBlock, Spinner } from '../components/ui';

type Step = 'password' | 'second';

function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export function LoginPage() {
  const auth = useAuthState();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));

  const [step, setStep] = useState<Step>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState<null | 'password' | 'second' | 'passkey'>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (auth.data?.secondFactorPending) setStep('second');
  }, [auth.data?.secondFactorPending]);

  if (auth.isPending) return <LoadingBlock label="Connexion à Ant…" />;
  if (auth.data?.setupRequired || auth.data?.enrolmentPending) return <Navigate to="/setup" replace />;
  if (auth.data?.authenticated) return <Navigate to={next} replace />;

  const done = async () => {
    await qc.invalidateQueries({ queryKey: qk.authState });
    navigate(next, { replace: true });
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy('password');
    try {
      await post('/api/auth/login', { password });
      setPassword('');
      setStep('second');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const submitSecond = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy('second');
    try {
      const value = code.trim();
      await post('/api/auth/login/second-factor', useRecovery ? { recoveryCode: value } : { code: value.replace(/\s/g, '') });
      await done();
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(null);
    }
  };

  const passkey = async () => {
    setError(null);
    setBusy('passkey');
    try {
      await loginWithPasskey();
      await done();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const showPasskey = passkeysSupported() && (auth.data?.hasPasskey ?? true);

  return (
    <AuthLayout
      title={step === 'password' ? 'Connexion' : 'Deuxième facteur'}
      subtitle={
        step === 'password'
          ? 'Ant est réservé à son propriétaire.'
          : useRecovery
            ? 'Saisis un de tes codes de secours. Chaque code ne sert qu’une fois.'
            : 'Saisis le code à 6 chiffres affiché par ton application d’authentification.'
      }
    >
      <div className="space-y-4">
        <FormError message={error} />
        {step === 'password' ? (
          <form onSubmit={submitPassword} className="space-y-4">
            <div>
              <label className="label" htmlFor="password">
                Mot de passe
              </label>
              <input
                id="password"
                type="password"
                className="input"
                autoComplete="current-password"
                autoFocus
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={!password || busy !== null}>
              {busy === 'password' ? <Spinner className="size-4 text-accent-fg" /> : null}
              Continuer
            </button>
          </form>
        ) : (
          <form onSubmit={submitSecond} className="space-y-4">
            <div>
              <label className="label" htmlFor="code">
                {useRecovery ? 'Code de secours' : 'Code de vérification'}
              </label>
              <input
                id="code"
                className="input mono tracking-[0.15em]"
                autoFocus
                required
                autoComplete="one-time-code"
                inputMode={useRecovery ? 'text' : 'numeric'}
                pattern={useRecovery ? undefined : '[0-9 ]{6,7}'}
                maxLength={useRecovery ? 64 : 7}
                placeholder={useRecovery ? 'xxxx-xxxx-xxxx' : '123 456'}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={!code.trim() || busy !== null}>
              {busy === 'second' ? <Spinner className="size-4 text-accent-fg" /> : null}
              Se connecter
            </button>
            <div className="flex justify-between text-[13px]">
              <button
                type="button"
                className="text-accent-text underline-offset-2 hover:underline"
                onClick={() => {
                  setUseRecovery((v) => !v);
                  setCode('');
                  setError(null);
                }}
              >
                {useRecovery ? 'Utiliser l’application d’authentification' : 'Utiliser un code de secours'}
              </button>
              <button
                type="button"
                className="text-muted hover:text-fg"
                onClick={() => {
                  setStep('password');
                  setError(null);
                }}
              >
                Retour
              </button>
            </div>
          </form>
        )}

        {showPasskey && step === 'password' && (
          <>
            <div className="flex items-center gap-3 text-[12px] text-subtle">
              <div className="h-px flex-1 bg-line" />
              ou
              <div className="h-px flex-1 bg-line" />
            </div>
            <button type="button" className="btn w-full" onClick={() => void passkey()} disabled={busy !== null}>
              {busy === 'passkey' ? <Spinner /> : <KeyRound className="size-4" />}
              Se connecter avec une passkey
            </button>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
