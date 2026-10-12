import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SettingsDTO } from '@ant/shared';
import { patch } from '../../lib/api';
import { qk } from '../../lib/queries';
import { toast } from '../../lib/toast';

export function useUpdateSettings(successMessage = 'Réglages enregistrés') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Partial<SettingsDTO>) => patch<SettingsDTO>('/api/settings', p),
    onSuccess: (s) => {
      qc.setQueryData(qk.settings, s);
      // Mode, thresholds and caps feed the quota status.
      void qc.invalidateQueries({ queryKey: qk.quota });
      toast.success(successMessage);
    },
    onError: (err) => toast.fromError(err, 'Réglages non enregistrés'),
  });
}

/** Keys whose value differs (deep compare through JSON, settings are plain data). */
export function settingsDiff(base: SettingsDTO, draft: SettingsDTO): Partial<SettingsDTO> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(draft) as (keyof SettingsDTO)[]) {
    if (JSON.stringify(base[k]) !== JSON.stringify(draft[k])) out[k] = draft[k];
  }
  return out as Partial<SettingsDTO>;
}
