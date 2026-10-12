import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ComputerHolder, ComputerStatusDTO } from '@ant/shared';
import { post } from '../../lib/api';
import { qk } from '../../lib/queries';
import { toast } from '../../lib/toast';

/** Take or give back control of the agents' computer. */
export function useComputerControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (holder: ComputerHolder) => post<ComputerStatusDTO>('/api/computer/control', { holder }),
    onSuccess: (s) => {
      qc.setQueryData(qk.computerStatus, s);
      toast.info(s.holder === 'user' ? 'Tu as la main' : 'Les agents ont repris la main');
    },
    onError: (err) => toast.fromError(err, 'Changement de contrôle impossible'),
  });
}
