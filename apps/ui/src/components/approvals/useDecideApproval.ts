import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApprovalDecisionInput, ApprovalDTO } from '@ant/shared';
import { post } from '../../lib/api';
import { applyApprovalUpdate } from '../../lib/cache';
import { qk } from '../../lib/queries';
import { toast } from '../../lib/toast';

export function useDecideApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ApprovalDecisionInput & { id: string }) =>
      post<ApprovalDTO>(`/api/approvals/${id}/decide`, input),
    onSuccess: (a) => {
      qc.setQueryData<ApprovalDTO[]>(qk.approvals('pending'), (d) => applyApprovalUpdate(d, a, true));
      qc.setQueryData<ApprovalDTO[]>(qk.approvals('all'), (d) => applyApprovalUpdate(d, a, false));
      toast.success(a.status === 'rejected' ? 'Action refusée' : 'Action approuvée', a.title);
    },
    onError: (err) => toast.fromError(err, 'Décision non enregistrée'),
  });
}
