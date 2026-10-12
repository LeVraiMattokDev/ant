import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { post } from '../../lib/api';
import { toast } from '../../lib/toast';
import { realtime } from '../../lib/ws';

export function useLogout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => post('/api/auth/logout'),
    onSettled: () => {
      realtime.stop();
      qc.clear();
      navigate('/login', { replace: true });
    },
    onError: (err) => toast.fromError(err, 'Déconnexion incomplète'),
  });
}
