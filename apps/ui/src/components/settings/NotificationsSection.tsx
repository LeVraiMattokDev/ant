import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Bell, BellOff } from 'lucide-react';
import { post } from '../../lib/api';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../../lib/push';
import { toast } from '../../lib/toast';
import { Badge, Spinner } from '../ui';
import { SettingsSection } from './SettingsSection';

type State = 'unknown' | 'unsupported' | 'denied' | 'off' | 'on';

export function NotificationsSection() {
  const [state, setState] = useState<State>('unknown');

  const refresh = async () => {
    if (!pushSupported()) return setState('unsupported');
    if (Notification.permission === 'denied') return setState('denied');
    const sub = await currentSubscription().catch(() => null);
    setState(sub ? 'on' : 'off');
  };

  useEffect(() => {
    void refresh();
  }, []);

  const enable = useMutation({
    mutationFn: enablePush,
    onSuccess: () => {
      toast.success('Notifications activées sur cet appareil');
      void refresh();
    },
    onError: (err) => {
      toast.fromError(err, 'Notifications non activées');
      void refresh();
    },
  });
  const disable = useMutation({
    mutationFn: disablePush,
    onSuccess: () => {
      toast.info('Notifications désactivées sur cet appareil');
      void refresh();
    },
    onError: (err) => toast.fromError(err, 'Désactivation impossible'),
  });
  const test = useMutation({
    mutationFn: () => post<{ delivered: number }>('/api/push/test'),
    onSuccess: (r) =>
      r.delivered > 0
        ? toast.success('Notification de test envoyée', `${r.delivered} appareil${r.delivered > 1 ? 's' : ''}`)
        : toast.warning('Aucun appareil n’a reçu la notification', 'Active d’abord les notifications sur cet appareil.'),
    onError: (err) => toast.fromError(err, 'Test impossible'),
  });

  const status = {
    unknown: <Badge>Vérification…</Badge>,
    unsupported: <Badge tone="warning">Non disponibles ici</Badge>,
    denied: <Badge tone="danger">Bloquées par le navigateur</Badge>,
    off: <Badge>Désactivées</Badge>,
    on: <Badge tone="success">Activées sur cet appareil</Badge>,
  }[state];

  return (
    <SettingsSection
      id="notifications"
      title="Notifications"
      description="Relances, validations à donner et alertes de quota, même quand Ant est fermé. Les heures de silence s’appliquent."
    >
      <div className="flex items-center gap-2">{status}</div>
      {state === 'unsupported' && (
        <p className="text-[13px] text-muted">
          Ce navigateur ne gère pas les notifications push. Sur iPhone ou iPad (iOS 16.4+), ajoute d’abord Ant à l’écran d’accueil via « Partager →
          Sur l’écran d’accueil », puis ouvre-le depuis l’icône.
        </p>
      )}
      {state === 'denied' && (
        <p className="text-[13px] text-muted">Les notifications ont été refusées pour ce site. Réautorise-les dans les réglages du navigateur, puis recharge la page.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {state === 'off' && (
          <button type="button" className="btn btn-primary" onClick={() => enable.mutate()} disabled={enable.isPending}>
            {enable.isPending ? <Spinner className="size-4 text-accent-fg" /> : <Bell className="size-4" />}
            Activer les notifications
          </button>
        )}
        {state === 'on' && (
          <button type="button" className="btn" onClick={() => disable.mutate()} disabled={disable.isPending}>
            {disable.isPending ? <Spinner /> : <BellOff className="size-4" />}
            Désactiver sur cet appareil
          </button>
        )}
        <button type="button" className="btn" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending && <Spinner />}
          Envoyer une notification de test
        </button>
      </div>
    </SettingsSection>
  );
}
