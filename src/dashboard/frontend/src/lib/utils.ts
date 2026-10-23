import type { Milestone, Sprint } from '@/types';

/** The milestone statuses the `milestones` table stores. */
type MilestoneStatus = 'planned' | 'active' | 'completed';

/**
 * Drop archived milestones/epics from a picker list, keeping the one that is currently
 * selected (so an archived link still renders its name instead of a blank option).
 */
export function hideArchived<T extends { id: number; archived_at?: string | null }>(
  items: T[],
  keepId?: number | null,
): T[] {
  return items.filter((i) => !i.archived_at || i.id === keepId);
}

/**
 * Parse the MILESTONES skill markdown into structured Milestone objects.
 *
 * Expected format per section:
 *   ## Milestone N: Name — STATUS
 *   **Status:** ... (Sprints ...)
 *   **Goal:** description text
 */
export function parseMilestoneMarkdown(content: string): Milestone[] {
  const milestones: Milestone[] = [];
  // Split on "## Milestone" headers
  const sections = content.split(/(?=^## Milestone \d)/m);

  for (const section of sections) {
    const headerMatch = section.match(/^## Milestone (\d+):\s*(.+?)(?:\s*[—–-]\s*(.+?))?\s*$/m);
    if (!headerMatch) continue;

    const id = parseInt(headerMatch[1], 10);
    const name = headerMatch[2].trim();
    const statusHint = (headerMatch[3] || '').trim().toUpperCase();

    // Extract goal / description
    const goalMatch = section.match(/\*\*Goal:\*\*\s*(.+)/i);
    const description = goalMatch ? goalMatch[1].trim() : null;

    // Map the heading to a stored status: planned, active or completed.
    let status: MilestoneStatus = 'planned';
    if (/COMPLETE|DONE/.test(statusHint)) {
      status = 'completed';
    } else if (/IN\s*PROGRESS|ACTIVE/.test(statusHint)) {
      status = 'active';
    }

    const progress = status === 'completed' ? 100 : status === 'active' ? 50 : 0;

    milestones.push({
      id,
      name: `Milestone ${id}: ${name}`,
      description,
      status,
      target_date: null,
      progress,
      ticket_count: 0,
      done_count: 0,
    });
  }

  return milestones;
}

/**
 * Map a milestone to its sprint IDs based on chronological ordering.
 * - Milestone 1 (Production Foundation): first 4 sprints
 * - Milestone 3 (Ecosystem Growth): sprint-11-mcp-bootstrap and beyond
 * - Milestone 2 (Dashboard & Process Platform): everything else
 */
export function getMilestoneSprintIds(milestoneName: string, sprints: Sprint[]): number[] {
  const sorted = [...sprints].sort((a, b) =>
    (a.created_at || '').localeCompare(b.created_at || ''),
  );

  if (milestoneName.includes('Production Foundation') || milestoneName.includes('Milestone 1')) {
    return sorted.slice(0, 4).map((s) => s.id);
  }
  if (milestoneName.includes('Ecosystem') || milestoneName.includes('Milestone 3')) {
    return sorted
      .filter((s) => s.name.includes('mcp-bootstrap') || s.name.includes('sprint-11'))
      .map((s) => s.id);
  }
  // Milestone 2: everything not in M1 or M3
  const m1Ids = new Set(sorted.slice(0, 4).map((s) => s.id));
  const m3Names = ['mcp-bootstrap', 'sprint-11'];
  return sorted
    .filter((s) => !m1Ids.has(s.id) && !m3Names.some((n) => s.name.includes(n)))
    .map((s) => s.id);
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

export const langColors: Record<string, string> = {
  typescript: '#3178c6',
  javascript: '#f7df1e',
  css: '#264de4',
  json: '#292929',
  html: '#e34c26',
  markdown: '#083fa1',
  python: '#3572A5',
  unknown: '#666',
};

export function getMoodColor(score: number): string {
  if (score >= 60) return 'var(--color-accent)';
  if (score >= 40) return 'var(--color-orange)';
  return 'var(--color-red)';
}

/** Join class names; falsy parts drop out: `cx('px-2', active && 'text-accent')`. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
