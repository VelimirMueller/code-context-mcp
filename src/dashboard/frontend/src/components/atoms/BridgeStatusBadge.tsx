import { useEffect } from 'react';
import { useBridgeStore } from '@/stores/bridgeStore';

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
    ? '#f97316'
    : hasClaimed
      ? 'var(--blue)'
      : hasPending
        ? 'var(--yellow, #eab308)'
        : 'var(--green, #10b981)';
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
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10,
        color: hasWizard ? '#f97316' : 'var(--text3)',
        fontFamily: 'var(--mono)',
        padding: '3px 8px',
        background: hasWizard ? 'rgba(249, 115, 22, 0.08)' : 'var(--surface)',
        border: `1px solid ${hasWizard ? 'rgba(249, 115, 22, 0.3)' : 'var(--border)'}`,
        borderRadius: 6,
        cursor: hasWizard ? 'pointer' : 'default',
        transition: 'all 0.2s',
      }}
      onClick={hasWizard ? () => useBridgeStore.setState({ wizardOpen: true }) : undefined}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: dotColor,
          animation: hasWizard || hasClaimed ? 'pulse 1s ease-in-out infinite' : undefined,
        }}
      />
      {label}
    </div>
  );
}
