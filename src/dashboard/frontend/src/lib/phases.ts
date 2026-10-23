/* ------------------------------------------------------------------ */
/*  New 4-phase model (Sprint 77)                                      */
/*  Legacy phases from DB are mapped to these 4 display phases.        */
/* ------------------------------------------------------------------ */

export const PHASE_COLORS: Record<string, { bg: string; border: string; label: string }> = {
  planning: { bg: '#60a5fa', border: '#60a5fa', label: 'Planning' },
  implementation: { bg: '#fbbf24', border: '#fbbf24', label: 'Implementation' },
  done: { bg: '#10b981', border: '#34d399', label: 'Done' },
  rest: { bg: '#6b6b84', border: '#9ca3af', label: 'Rest' },
};

export const PHASE_ORDER = ['planning', 'implementation', 'done', 'rest'];

/**
 * Map any legacy phase name (from the DB) to one of the 4 canonical phases.
 * Returns the canonical key string.
 */
export function mapLegacyPhase(phase: string): string {
  const p = phase.toLowerCase().trim();
  switch (p) {
    case 'preparation':
    case 'kickoff':
    case 'planning':
      return 'planning';
    case 'implementation':
    case 'qa':
    case 'refactoring':
      return 'implementation';
    case 'retro':
    case 'review':
    case 'closed':
    case 'done':
      return 'done';
    case 'rest':
      return 'rest';
    default:
      return 'planning';
  }
}

export function getPhaseStyle(status: string) {
  const canonical = mapLegacyPhase(status);
  return PHASE_COLORS[canonical] ?? PHASE_COLORS.planning;
}

/**
 * Get the display label for any phase value (legacy or new).
 */
export function getPhaseLabel(status: string): string {
  return getPhaseStyle(status).label;
}
