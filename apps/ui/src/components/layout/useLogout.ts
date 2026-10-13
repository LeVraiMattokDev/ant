import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { post } from '../../lib/api';
import { disablePush } from '../../lib/push';
import { toast } from '../../lib/toast';
import { realtime } from '../../lib/ws';

export function useLogout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async () => {
      // A device left (borrowed or shared computer) must stop showing notifications. Done first, while the
      // session still exists, and never blocking the logout itself.
      await disablePush().catch(() => undefined);
      await post('/api/auth/logout');
    },
    onSettled: () => {
      realtime.stop();
      qc.clear();
      navigate('/login', { replace: true });
    },
    onError: (err) => toast.fromError(err, 'Déconnexion incomplète'),
  });
}
