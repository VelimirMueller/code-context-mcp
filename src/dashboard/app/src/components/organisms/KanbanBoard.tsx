import { useState, useEffect, useMemo } from 'react';
import type { Ticket } from '@/types';
import { TicketCard } from '@/components/molecules/TicketCard';
import { TicketDetailModal } from './TicketDetailModal';
import { usePlanningStore } from '@/stores/planningStore';
import { useSprintStore } from '@/stores/sprintStore';
import { get, patch } from '@/lib/api';
import type { Epic } from '@/types';

interface KanbanBoardProps {
  tickets: Ticket[];
}

interface ColConfig {
  label: string;
  color: string;
}

const COLUMNS: Record<string, ColConfig> = {
  TODO: { label: 'To Do', color: '#6b6b84' },
  IN_PROGRESS: { label: 'In Progress', color: 'var(--blue)' },
  DONE: { label: 'Done', color: 'var(--green)' },
  NOT_DONE: { label: 'Not Done', color: 'var(--red)' },
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
    const setStatus = (status: string) =>
      setLocalTickets((ts) => ts.map((t) => (t.id === ticketId ? { ...t, status } : t)));
    setStatus(targetStatus);
    const updated = await updateTicket(ticketId, { status: targetStatus });
    if (!updated) {
      setStatus(previous.status);
      return;
    }
    if (selectedSprintId) fetchTickets(selectedSprintId);
  };

  const renderColumns = (columnTickets: Ticket[]) => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1.5fr 1fr 0.8fr',
        gap: 12,
        padding: '12px 0',
      }}
    >
      {Object.entries(COLUMNS).map(([status, cfg]) => {
        const colTickets = columnTickets.filter((t) => t.status === status);
        const pts = colTickets.reduce((sum, t) => sum + (t.story_points ?? 0), 0);

        return (
          <div
            key={status}
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
            style={{
              background: dragOverCol === status ? 'rgba(99,102,241,0.04)' : 'var(--bg)',
              border:
                dragOverCol === status ? '1px solid var(--accent)' : '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 200,
              transition: 'border-color 0.15s, background 0.15s',
            }}
          >
            {/* Column header */}
            <div
              style={{
                padding: '10px 12px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: cfg.color,
                  }}
                />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                  {cfg.label}
                </span>
              </div>
              <span
                style={{
                  fontSize: 10,
                  color: 'var(--text3)',
                  fontFamily: 'var(--mono)',
                }}
              >
                {colTickets.length} · {pts}sp
              </span>
            </div>

            {/* Cards */}
            <div style={{ padding: 8, overflowY: 'auto', flex: 1 }}>
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
                  style={{ cursor: 'grab', opacity: draggingId === ticket.id ? 0.4 : 1 }}
                >
                  <TicketCard
                    ticket={ticket}
                    onClick={() => setSelectedTicket(ticket)}
                    onEdit={() => setSelectedTicket(ticket)}
                  />
                </div>
              ))}
              {colTickets.length === 0 && (
                <div
                  style={{
                    padding: '20px 8px',
                    textAlign: 'center',
                    fontSize: 11,
                    color: 'var(--text3)',
                  }}
                >
                  Empty
                </div>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 0' }}>
        <button
          onClick={() => setGroupByEpic((v) => !v)}
          style={{
            background: groupByEpic ? 'var(--accent)' : 'var(--surface)',
            color: groupByEpic ? '#000' : 'var(--text3)',
            border: `1px solid ${groupByEpic ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 7,
            padding: '5px 12px',
            fontSize: 11.5,
            fontWeight: 650,
            cursor: 'pointer',
            fontFamily: 'var(--font)',
            transition: 'all .2s',
          }}
        >
          Group by Epic
        </button>
      </div>

      {groupByEpic && epicGroups ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {epicGroups.map(([epicName, groupTickets]) => {
            const color = epicColorMap.get(epicName) ?? 'var(--border)';
            return (
              <div key={epicName}>
                {/* Epic section header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 0 2px',
                    borderLeft: `4px solid ${color}`,
                    paddingLeft: 12,
                    marginTop: 8,
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                    {epicName}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
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
