import { useState, useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { Ticket } from '@/types';
import { TicketCard } from '@/components/molecules/TicketCard';
import { TicketDetailModal } from './TicketDetailModal';
import { usePlanningStore } from '@/stores/planningStore';
import { useSprintStore } from '@/stores/sprintStore';
import { get, patch } from '@/lib/api';
import type { Epic } from '@/types';
import { cx } from '@/lib/utils';

interface KanbanBoardProps {
  tickets: Ticket[];
}

interface ColConfig {
  label: string;
  dot: string;
}

const COLUMNS: Record<string, ColConfig> = {
  TODO: { label: 'To Do', dot: 'bg-[#6b6b84]' },
  IN_PROGRESS: { label: 'In Progress', dot: 'bg-blue' },
  DONE: { label: 'Done', dot: 'bg-green' },
  NOT_DONE: { label: 'Not Done', dot: 'bg-red' },
};

export function KanbanBoard({ tickets }: KanbanBoardProps) {
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [groupByEpic, setGroupByEpic] = useState(false);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [localTickets, setLocalTickets] = useState<Ticket[]>(tickets);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const milestones = usePlanningStore((s) => s.milestones);
  const fetchMilestones = usePlanningStore((s) => s.fetchMilestones);
  const selectedSprintId = useSprintStore((s) => s.selectedSprintId);
  const fetchTickets = useSprintStore((s) => s.fetchTickets);
  const updateTicket = useSprintStore((s) => s.updateTicket);
  const fetchGrouped = useSprintStore((s) => s.fetchGroupedSprints);

  useEffect(() => {
    setLocalTickets(tickets);
  }, [tickets]);

  useEffect(() => {
    if (milestones.length === 0) fetchMilestones();
  }, [milestones.length, fetchMilestones]);

  useEffect(() => {
    if (groupByEpic && epics.length === 0) {
      get<Epic[]>('/api/epics')
        .then((data) => {
          if (Array.isArray(data)) setEpics(data);
        })
        .catch(() => {});
    }
  }, [groupByEpic, epics.length]);

  const epicColorMap = useMemo(() => {
    const map = new Map<string, string>();
    epics.forEach((e) => map.set(e.name, e.color));
    return map;
  }, [epics]);

  const epicGroups = useMemo(() => {
    if (!groupByEpic) return null;
    const groups = new Map<string, Ticket[]>();
    for (const t of localTickets) {
      const key = t.epic_name ?? 'No Epic';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }
    // Sort: named epics first, "No Epic" last
    const sorted = [...groups.entries()].sort((a, b) => {
      if (a[0] === 'No Epic') return 1;
      if (b[0] === 'No Epic') return -1;
      return a[0].localeCompare(b[0]);
    });
    return sorted;
  }, [groupByEpic, localTickets]);

  const handleMilestoneChange = async (ticketId: number, milestoneId: number | null) => {
    await patch(`/api/ticket/${ticketId}/milestone`, { milestone_id: milestoneId });
    const milestone = milestones.find((m) => m.id === milestoneId);
    if (selectedTicket && selectedTicket.id === ticketId) {
      setSelectedTicket({
        ...selectedTicket,
        milestone: milestone?.name ?? null,
        milestone_id: milestoneId ?? undefined,
      });
    }
    // Re-fetch sprint tickets and milestone groupings so the board updates
    if (selectedSprintId) fetchTickets(selectedSprintId);
    fetchGrouped();
  };

  const handleEpicChange = async (ticketId: number, epicId: number | null) => {
    await patch(`/api/ticket/${ticketId}/epic`, { epic_id: epicId });
    if (selectedTicket && selectedTicket.id === ticketId) {
      setSelectedTicket({
        ...selectedTicket,
        epic_id: epicId ?? undefined,
      });
    }
    // Re-fetch sprint tickets so the board updates
    if (selectedSprintId) fetchTickets(selectedSprintId);
  };

  // A drop changes the status through PATCH /api/ticket/:id (#198), the same
  // route the ticket editor uses. The server allows TODO, IN_PROGRESS and
  // BLOCKED only; DONE and NOT_DONE stay with the QA gate, so such a drop
  // reverts and updateTicket shows the server error.
  const handleDrop = async (e: React.DragEvent, targetStatus: string) => {
    e.preventDefault();
    setDraggingId(null);
    setDragOverCol(null);
    const ticketId = Number(e.dataTransfer.getData('ticketId'));
    const previous = localTickets.find((t) => t.id === ticketId);
    if (!previous || previous.status === targetStatus) return;
    // `from` guards the swap: a later drop or refetch is never overwritten.
    const swapStatus = (from: string, to: string) =>
      setLocalTickets((ts) =>
        ts.map((t) => (t.id === ticketId && t.status === from ? { ...t, status: to } : t)),
      );
    swapStatus(previous.status, targetStatus);
    const updated = await updateTicket(ticketId, { status: targetStatus }).catch(() => null);
    if (!updated) {
      swapStatus(targetStatus, previous.status);
      return;
    }
    if (selectedSprintId) fetchTickets(selectedSprintId);
  };

  const renderColumns = (columnTickets: Ticket[]) => (
    <div className="grid grid-cols-[2fr_1.5fr_1fr_0.8fr] gap-3 py-3">
      {Object.entries(COLUMNS).map(([status, cfg]) => {
        const colTickets = columnTickets.filter((t) => t.status === status);
        const pts = colTickets.reduce((sum, t) => sum + (t.story_points ?? 0), 0);

        return (
          <div
            key={status}
            data-testid="kanban-column"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverCol(status);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDragOverCol(null);
              }
            }}
            onDrop={(e) => handleDrop(e, status)}
            className={cx(
              'flex min-h-50 flex-col rounded-card border [transition:border-color_0.15s,background_0.15s]',
              dragOverCol === status
                ? 'bg-[rgba(99,102,241,0.04)] border-accent'
                : 'bg-bg border-line',
            )}
          >
            {/* Column header */}
            <div className="flex shrink-0 items-center justify-between border-b border-b-line px-3 py-[10px]">
              <div className="flex items-center gap-1.5">
                <div className={cx('h-2 w-2 rounded-[50%]', cfg.dot)} />
                <span className="text-12 font-semibold text-fg">{cfg.label}</span>
              </div>
              <span className="font-code text-10 text-fg-3">
                {colTickets.length} · {pts}sp
              </span>
            </div>

            {/* Cards */}
            <div className="flex-1 overflow-y-auto p-2">
              {colTickets.map((ticket) => (
                <div
                  key={ticket.id}
                  draggable
                  onDragStart={(e) => {
                    setDraggingId(ticket.id);
                    e.dataTransfer.setData('ticketId', String(ticket.id));
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDragOverCol(null);
                  }}
                  className={cx(
                    'cursor-grab',
                    draggingId === ticket.id ? 'opacity-40' : 'opacity-100',
                  )}
                >
                  <TicketCard
                    ticket={ticket}
                    onClick={() => setSelectedTicket(ticket)}
                    onEdit={() => setSelectedTicket(ticket)}
                  />
                </div>
              ))}
              {colTickets.length === 0 && (
                <div className="px-2 py-5 text-center text-11 text-fg-3">Empty</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      {/* Group by Epic toggle */}
      <div className="flex items-center gap-2 pt-2">
        <button
          onClick={() => setGroupByEpic((v) => !v)}
          className={cx(
            'cursor-pointer rounded-[7px] border px-3 py-[5px] font-body text-[11.5px] font-[650] transition-all',
            groupByEpic
              ? 'bg-accent text-[#000] border-accent'
              : 'bg-surface text-fg-3 border-line',
          )}
        >
          Group by Epic
        </button>
      </div>

      {groupByEpic && epicGroups ? (
        <div className="flex flex-col gap-1">
          {epicGroups.map(([epicName, groupTickets]) => {
            const color = epicColorMap.get(epicName) ?? 'var(--color-line)';
            return (
              <div key={epicName}>
                {/* Epic section header */}
                <div
                  style={{ '--c': color } as CSSProperties}
                  className="mt-2 flex items-center gap-[10px] border-l-4 border-l-(--c) pb-0.5 pl-3 pt-[10px]"
                >
                  <span className="text-13 font-bold text-fg">{epicName}</span>
                  <span className="font-code text-11 text-fg-3">
                    {groupTickets.length} ticket{groupTickets.length !== 1 ? 's' : ''}
                  </span>
                </div>
                {renderColumns(groupTickets)}
              </div>
            );
          })}
        </div>
      ) : (
        renderColumns(localTickets)
      )}

      <TicketDetailModal
        ticket={selectedTicket}
        milestones={milestones}
        onClose={() => setSelectedTicket(null)}
        onMilestoneChange={handleMilestoneChange}
        onEpicChange={handleEpicChange}
        onTicketUpdate={(ticketId, updates) => {
          setLocalTickets((prev) =>
            prev.map((t) => (t.id === ticketId ? { ...t, ...updates } : t)),
          );
          if (selectedTicket?.id === ticketId)
            setSelectedTicket((t) => (t ? { ...t, ...updates } : t));
        }}
      />
    </>
  );
}
