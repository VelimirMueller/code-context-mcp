'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { EnterpriseDataTable, type Column } from './EnterpriseDataTable';
import { useSprintStore } from '@/stores/sprintStore';
import { usePlanningStore } from '@/stores/planningStore';
import { get } from '@/lib/api';
import { mapLegacyPhase, getPhaseStyle } from '@/lib/phases';
import { StatusBadge } from '@/components/atoms/StatusBadge';
import { AssignmentChips } from '@/components/molecules/AssignmentChips';
import type { Sprint, Ticket } from '@/types';

/* ─── Types ───────────────────────────────────────────────────────────────── */

type ViewMode = 'sprints' | 'tickets';

/* ─── Status Color Map ─────────────────────────────────────────────────────── */

const STATUS_COLORS: Record<string, string> = {
  TODO: '#6b6b84',
  IN_PROGRESS: '#60a5fa',
  DONE: '#10b981',
  BLOCKED: '#f87171',
  PARTIAL: '#fbbf24',
  NOT_DONE: '#6b6b84',
};

const PRIORITY_COLORS: Record<string, string> = {
  P0: '#f87171',
  P1: '#fbbf24',
  P2: '#60a5fa',
  P3: '#6b6b84',
};

/* ─── Main Component ──────────────────────────────────────────────────────── */

export function SprintTableView() {
  const sprints = useSprintStore((s) => s.sprints);
  const [viewMode, setViewMode] = useState<ViewMode>('sprints');
  const [selectedSprintId, setSelectedSprintId] = useState<number | null>(null);
  const [sprintTickets, setSprintTickets] = useState<Ticket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(false);
  const [sprintFilter, setSprintFilter] = useState<string>('all');

  // Fetch tickets when a sprint is selected
  useEffect(() => {
    if (!selectedSprintId) {
      setSprintTickets([]);
      return;
    }
    setLoadingTickets(true);
    get<Ticket[]>(`/api/sprint/${selectedSprintId}/tickets`)
      .then(tickets => setSprintTickets(Array.isArray(tickets) ? tickets : []))
      .catch(() => setSprintTickets([]))
      .finally(() => setLoadingTickets(false));
  }, [selectedSprintId]);

  // Filtered sprints
  const filteredSprints = useMemo(() => {
    if (sprintFilter === 'all') return sprints;
    return sprints.filter(s => mapLegacyPhase(s.status) === sprintFilter);
  }, [sprints, sprintFilter]);

  // Sprint columns
  const sprintColumns = useMemo<Column<Sprint>[]>(() => [
    {
      id: 'name',
      header: 'Sprint',
      sortable: true,
      filterable: true,
      width: 200,
      cell: (row: Sprint) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.name}
          </span>
          {row.goal && (
            <span style={{ fontSize: 11, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>
              {row.goal}
            </span>
          )}
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      filterable: true,
      width: 120,
      cell: (row: Sprint) => {
        const phase = getPhaseStyle(row.status);
        return (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 10px',
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'var(--mono)',
            background: `${phase.bg}20`,
            color: phase.bg,
            border: `1px solid ${phase.bg}30`,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: phase.bg }} />
            {phase.label}
          </span>
        );
      },
      filterFn: (row: Sprint, value: string) => {
        const phase = mapLegacyPhase(row.status);
        return phase.toLowerCase().includes(value.toLowerCase()) || row.status.toLowerCase().includes(value.toLowerCase());
      },
    },
    {
      id: 'velocity',
      header: 'Velocity',
      sortable: true,
      width: 100,
      align: 'center',
      cell: (row: Sprint) => {
        const committed = row.velocity_committed || 0;
        const completed = row.velocity_completed || 0;
        const pct = committed > 0 ? Math.round((completed / committed) * 100) : 0;
        const color = pct >= 80 ? '#10b981' : pct >= 50 ? '#fbbf24' : '#f87171';
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              {completed}/{committed}
            </span>
            <div style={{ width: 60, height: 3, background: 'var(--surface3)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2, transition: 'width .3s' }} />
            </div>
          </div>
        );
      },
    },
    {
      id: 'tickets',
      header: 'Tickets',
      sortable: true,
      width: 100,
      align: 'center',
      cell: (row: Sprint) => (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text)' }}>
            {row.done_count}/{row.ticket_count}
          </span>
          {row.ticket_count > 0 && (
            <div style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              fontWeight: 700,
              fontFamily: 'var(--mono)',
              background: row.done_count === row.ticket_count ? '#10b98120' : row.done_count > row.ticket_count / 2 ? '#60a5fa20' : '#fbbf2420',
              color: row.done_count === row.ticket_count ? '#10b981' : row.done_count > row.ticket_count / 2 ? '#60a5fa' : '#fbbf24',
            }}>
              {row.ticket_count > 0 ? Math.round((row.done_count / row.ticket_count) * 100) : 0}%
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'blockers',
      header: 'Blockers',
      sortable: true,
      width: 80,
      align: 'center',
      cell: (row: Sprint) => (
        <span style={{
          fontFamily: 'var(--mono)',
          fontSize: 13,
          fontWeight: 600,
          color: row.open_blockers > 0 ? '#f87171' : 'var(--text3)',
        }}>
          {row.open_blockers}
        </span>
      ),
    },
    {
      id: 'dates',
      header: 'Dates',
      sortable: true,
      width: 160,
      cell: (row: Sprint) => (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text3)' }}>
          {row.start_date ? row.start_date.slice(0, 10) : '---'} → {row.end_date ? row.end_date.slice(0, 10) : '---'}
        </span>
      ),
    },
  ], []);

  // Ticket columns
  const ticketColumns = useMemo<Column<Ticket>[]>(() => [
    {
      id: 'ticket_ref',
      header: 'Ref',
      sortable: true,
      filterable: true,
      width: 80,
      cell: (row: Ticket) => (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--blue)' }}>
          {row.ticket_ref || `#${row.id}`}
        </span>
      ),
    },
    {
      id: 'title',
      header: 'Title',
      sortable: true,
      filterable: true,
      cell: (row: Ticket) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontWeight: 500, color: 'var(--text)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>
            {row.title}
          </span>
          {row.epic_name && (
            <span style={{ fontSize: 10, color: 'var(--purple)', fontWeight: 500 }}>
              {row.epic_name}
            </span>
          )}
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      filterable: true,
      width: 120,
      cell: (row: Ticket) => {
        const color = STATUS_COLORS[row.status] || '#6b6b84';
        const label = row.status.replace(/_/g, ' ');
        return (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 10px',
            borderRadius: 4,
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'var(--mono)',
            background: `${color}20`,
            color,
            border: `1px solid ${color}30`,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: color }} />
            {label}
          </span>
        );
      },
      filterFn: (row: Ticket, value: string) => row.status.toLowerCase().includes(value.toLowerCase()),
    },
    {
      id: 'priority',
      header: 'Priority',
      sortable: true,
      filterable: true,
      width: 80,
      align: 'center',
      cell: (row: Ticket) => {
        const color = PRIORITY_COLORS[row.priority] || '#6b6b84';
        return (
          <span style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            fontWeight: 700,
            color,
            background: `${color}15`,
            padding: '2px 8px',
            borderRadius: 4,
          }}>
            {row.priority}
          </span>
        );
      },
      filterFn: (row: Ticket, value: string) => row.priority.toLowerCase().includes(value.toLowerCase()),
    },
    {
      id: 'assigned_to',
      header: 'Assigned',
      sortable: true,
      filterable: true,
      width: 140,
      cell: (row: Ticket) => (
        row.assignments && row.assignments.length > 0 ? (
          <AssignmentChips assignments={row.assignments} />
        ) : (
          <span style={{ fontSize: 12, color: row.assigned_to ? 'var(--text)' : 'var(--text3)', fontStyle: row.assigned_to ? 'normal' : 'italic' }}>
            {row.assigned_to || 'Unassigned'}
          </span>
        )
      ),
    },
    {
      id: 'story_points',
      header: 'Points',
      sortable: true,
      width: 70,
      align: 'center',
      cell: (row: Ticket) => (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
          {row.story_points || '-'}
        </span>
      ),
    },
    {
      id: 'qa',
      header: 'QA',
      width: 60,
      align: 'center',
      cell: (row: Ticket) => (
        <span style={{ fontSize: 14, color: row.qa_verified ? '#10b981' : '#fbbf24' }}>
          {row.qa_verified ? '\u2713' : '\u25CB'}
        </span>
      ),
    },
  ], []);

  const selectedSprint = sprints.find(s => s.id === selectedSprintId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
            Data Explorer
          </h2>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>
            Enterprise-grade sprint and ticket management
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {/* View mode toggle */}
          <div style={{ display: 'flex', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <button
              onClick={() => setViewMode('sprints')}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                border: 'none',
                background: viewMode === 'sprints' ? 'var(--accent)' : 'transparent',
                color: viewMode === 'sprints' ? '#000' : 'var(--text3)',
                cursor: 'pointer',
                fontFamily: 'var(--font)',
              }}
            >
              Sprints
            </button>
            <button
              onClick={() => setViewMode('tickets')}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                border: 'none',
                background: viewMode === 'tickets' ? 'var(--accent)' : 'transparent',
                color: viewMode === 'tickets' ? '#000' : 'var(--text3)',
                cursor: 'pointer',
                fontFamily: 'var(--font)',
              }}
            >
              Tickets
            </button>
          </div>
        </div>
      </div>

      {/* Sprint quick filters */}
      {viewMode === 'sprints' && (
        <div style={{ display: 'flex', gap: 6 }}>
          {['all', 'planning', 'implementation', 'done'].map((filter) => (
            <button
              key={filter}
              onClick={() => setSprintFilter(filter)}
              style={{
                padding: '5px 12px',
                fontSize: 11,
                fontWeight: 600,
                border: `1px solid ${sprintFilter === filter ? 'var(--accent)' : 'var(--border)'}`,
                background: sprintFilter === filter ? 'var(--accent)' : 'transparent',
                color: sprintFilter === filter ? '#000' : 'var(--text3)',
                borderRadius: 6,
                cursor: 'pointer',
                fontFamily: 'var(--font)',
                textTransform: 'capitalize',
              }}
            >
              {filter === 'all' ? 'All' : filter}
              {filter !== 'all' && (
                <span style={{ marginLeft: 4, fontFamily: 'var(--mono)', fontSize: 10 }}>
                  ({sprints.filter(s => mapLegacyPhase(s.status) === filter).length})
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Sprint breadcrumb when viewing tickets */}
      {viewMode === 'tickets' && selectedSprint && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
        }}>
          <button
            onClick={() => { setViewMode('sprints'); setSelectedSprintId(null); }}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'var(--font)',
              fontWeight: 600,
            }}
          >
            Sprints
          </button>
          <span style={{ color: 'var(--text3)' }}>/</span>
          <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>{selectedSprint.name}</span>
          <span style={{ fontSize: 11, color: 'var(--text3)' }}>
            ({sprintTickets.length} tickets)
          </span>
        </div>
      )}

      {/* Table */}
      <AnimatePresence mode="wait">
        {viewMode === 'sprints' && (
          <motion.div key="sprints" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <EnterpriseDataTable
              data={filteredSprints}
              columns={sprintColumns}
              keyField="id"
              sortable
              filterable
              pageSize={20}
              onRowClick={(row) => {
                setSelectedSprintId(row.id);
                setViewMode('tickets');
              }}
              rowClassName={(row) => {
                const phase = mapLegacyPhase(row.status);
                return phase === 'done' ? 'row-done' : phase === 'implementation' ? 'row-active' : undefined;
              }}
              emptyState={
                <div style={{ padding: 40, textAlign: 'center' }}>
                  <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.3 }}>📋</div>
                  <div style={{ color: 'var(--text3)', fontSize: 13 }}>No sprints found</div>
                  <div style={{ color: 'var(--text3)', fontSize: 11, marginTop: 4 }}>Create a sprint to get started</div>
                </div>
              }
            />
          </motion.div>
        )}

        {viewMode === 'tickets' && (
          <motion.div key="tickets" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <EnterpriseDataTable
              data={sprintTickets}
              columns={ticketColumns}
              keyField="id"
              sortable
              filterable
              pageSize={25}
              loading={loadingTickets}
              emptyState={
                <div style={{ padding: 40, textAlign: 'center' }}>
                  <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.3 }}>📋</div>
                  <div style={{ color: 'var(--text3)', fontSize: 13 }}>No tickets in this sprint</div>
                </div>
              }
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
