import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApprovalDecisionInput, ApprovalDTO } from '@ant/shared';
import { ApiError, post } from '../../lib/api';
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
    onError: (err) => {
      // 409: already decided or expired on the server. The list is out of date (missed event): reload it.
      if (err instanceof ApiError && err.status === 409) void qc.invalidateQueries({ queryKey: qk.approvalsAll });
      toast.fromError(err, 'Décision non enregistrée');
    },
  });
}
