import { useEffect } from 'react';
import { useBridgeStore } from '@/stores/bridgeStore';
import { cx } from '@/lib/utils';

export function BridgeStatusBadge() {
  const status = useBridgeStore((s) => s.status);
  const fetchStatus = useBridgeStore((s) => s.fetchStatus);
  const wizardOpen = useBridgeStore((s) => s.wizardOpen);
  const wizardSteps = useBridgeStore((s) => s.wizardSteps);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  if (!status) return null;

  const hasWizard = wizardOpen && wizardSteps.length > 0;
  const hasPending = status.pending > 0;
  const hasClaimed = status.claimed > 0;

  const dotColor = hasWizard
    ? 'bg-[#f97316]'
    : hasClaimed
      ? 'bg-blue'
      : hasPending
        ? 'bg-[#eab308]'
        : 'bg-green';
  const label = hasWizard
    ? `Wizard: ${wizardSteps.length} input${wizardSteps.length > 1 ? 's' : ''} requested`
    : hasClaimed
      ? `${status.claimed} action${status.claimed > 1 ? 's' : ''} running`
      : hasPending
        ? `${status.pending} action${status.pending > 1 ? 's' : ''} queued`
        : 'Bridge idle';

  return (
    <div
      title={
        hasWizard
          ? `Wizard active: ${wizardSteps.length} step(s) waiting for input`
          : `Bridge: ${status.pending} pending, ${status.claimed} claimed, ${status.completed} completed, ${status.failed} failed`
      }
      className={cx(
        'flex items-center gap-[5px] rounded-[6px] border px-2 py-[3px] font-code text-10 transition-all',
        hasWizard
          ? 'cursor-pointer border-[rgba(249,115,22,0.3)] bg-[rgba(249,115,22,0.08)] text-[#f97316]'
          : 'cursor-default border-line bg-surface text-fg-3',
      )}
      onClick={hasWizard ? () => useBridgeStore.setState({ wizardOpen: true }) : undefined}
    >
      <span
        className={cx(
          'h-[6px] w-[6px] rounded-[50%]',
          dotColor,
          (hasWizard || hasClaimed) && 'animate-[pulse_1s_ease-in-out_infinite]',
        )}
      />
      {label}
    </div>
  );
}
