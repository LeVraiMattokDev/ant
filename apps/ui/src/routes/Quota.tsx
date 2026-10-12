import { useQuota, useSettings } from '../lib/queries';
import { ApiCard, ComputeModeSelector, SubscriptionCard, ThresholdsCard } from '../components/quota/QuotaCards';
import { UsageSection } from '../components/quota/UsageSection';
import { ErrorBlock, LoadingBlock, PageHeader } from '../components/ui';

export default function QuotaPage() {
  const quota = useQuota();
  const settings = useSettings();

  return (
    <>
      <PageHeader title="Quota et budget" description="Où passe le calcul de tes bots : ton abonnement Claude ou tes crédits API." />
      <div className="scroll-y flex-1 p-4 md:p-6">
        <div className="mx-auto max-w-6xl space-y-4">
          {quota.isPending ? (
            <LoadingBlock />
          ) : quota.isError ? (
            <ErrorBlock error={quota.error} onRetry={() => void quota.refetch()} />
          ) : (
            <>
              {quota.data.allPaused && (
                <div role="alert" className="rounded-[6px] border border-danger/40 bg-danger-soft px-4 py-3 text-[13.5px]">
                  <div className="font-semibold text-danger">Toutes les exécutions sont en pause</div>
                  <div className="mt-0.5">{quota.data.pausedReason ?? 'Aucune source de calcul disponible.'}</div>
                </div>
              )}
              <ComputeModeSelector mode={quota.data.mode} />
              <div className="grid gap-4 lg:grid-cols-2">
                <SubscriptionCard quota={quota.data} settings={settings.data} />
                <div className="space-y-4">
                  <ApiCard quota={quota.data} settings={settings.data} />
                  <ThresholdsCard thresholds={quota.data.thresholds} settings={settings.data} />
                </div>
              </div>
            </>
          )}
          <UsageSection />
        </div>
      </div>
    </>
  );
}
