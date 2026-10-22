'use client';

import { useState, useMemo } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useAgentStore } from '@/stores/agentStore';
import { AgentCard } from '@/components/molecules/AgentCard';
import { TeamManagementModal } from '@/components/organisms/TeamManagementModal';
import type { Agent } from '@/types';

const DEPARTMENT_DISPLAY: Record<string, { label: string; color: string }> = {
  development: { label: 'Development', color: '#60a5fa' },
  business: { label: 'Business', color: '#818cf8' },
  quality: { label: 'Quality & Process', color: '#10b981' },
};

export function TeamGrid() {
  const agents = useAgentStore((s) => s.agents);
  const loading = useAgentStore((s) => s.loading);
  const fetchAgents = useAgentStore((s) => s.fetchAgents);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | undefined>(undefined);

  function handleAdd() {
    setEditingAgent(undefined);
    setModalOpen(true);
  }

  function handleEdit(agent: Agent) {
    setEditingAgent(agent);
    setModalOpen(true);
  }

  function handleClose() {
    setModalOpen(false);
    setEditingAgent(undefined);
  }

  if (loading && agents.length === 0) {
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 12,
          padding: 20,
        }}
      >
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            style={{
              height: 140,
              background: 'var(--surface2)',
              borderRadius: 'var(--radius)',
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflowY: 'auto' }}>
      {/* Header bar with title and Add button */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0 20px 12px',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Team Members</div>
        <button
          onClick={handleAdd}
          style={{
            padding: '6px 14px',
            fontSize: 12,
            fontWeight: 600,
            background: 'var(--pill-bg)',
            border: 'none',
            borderRadius: 'var(--radius-pill)',
            color: 'var(--pill-fg)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            transition: 'opacity 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = '0.8';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '1';
          }}
        >
          <span style={{ fontSize: 15, lineHeight: 1 }}>+</span> Add Member
        </button>
      </div>

      {/* Grouped grid or empty state */}
      {agents.length === 0 ? (
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--text3)', fontSize: 14 }}>
          No team members yet. Click "Add Member" to create your first agent.
        </div>
      ) : (
        <GroupedAgentGrid agents={agents} onEdit={handleEdit} />
      )}

      {/* Management Modal */}
      <AnimatePresence>
        {modalOpen && (
          <TeamManagementModal open={modalOpen} agent={editingAgent} onClose={handleClose} />
        )}
      </AnimatePresence>
    </div>
  );
}

interface GroupedAgentGridProps {
  agents: Agent[];
  onEdit: (agent: Agent) => void;
}

function GroupedAgentGrid({ agents, onEdit }: GroupedAgentGridProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const byDept = new Map<string, Agent[]>();
    for (const a of agents) {
      const dept = a.department || 'other';
      if (!byDept.has(dept)) byDept.set(dept, []);
      byDept.get(dept)!.push(a);
    }
    const result: { label: string; color: string; agents: Agent[] }[] = [];
    // Show known departments first in a stable order
    for (const key of ['development', 'business', 'quality']) {
      const group = byDept.get(key);
      if (group && group.length > 0) {
        const display = DEPARTMENT_DISPLAY[key] ?? {
          label: key.charAt(0).toUpperCase() + key.slice(1),
          color: 'var(--text3)',
        };
        result.push({ label: display.label, color: display.color, agents: group });
        byDept.delete(key);
      }
    }
    // Any remaining departments (custom ones added by users)
    for (const [key, group] of byDept) {
      if (group.length > 0) {
        const display = DEPARTMENT_DISPLAY[key] ?? {
          label: key.charAt(0).toUpperCase() + key.slice(1),
          color: 'var(--text3)',
        };
        result.push({ label: display.label, color: display.color, agents: group });
      }
    }
    return result;
  }, [agents]);

  const toggle = (label: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(label) ? next.delete(label) : next.add(label);
      return next;
    });
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
      {groups.map((group) => (
        <div key={group.label} style={{ marginBottom: 16 }}>
          <button
            onClick={() => toggle(group.label)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '8px 0',
              width: '100%',
              fontFamily: 'var(--font)',
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              style={{
                transform: collapsed.has(group.label) ? 'none' : 'rotate(90deg)',
                transition: 'transform .2s',
                flexShrink: 0,
              }}
            >
              <path
                d="M4 2L8 6L4 10"
                stroke={group.color}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: group.color,
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
              {group.label}
            </span>
            <span
              style={{
                fontSize: 11,
                color: 'var(--text3)',
                fontFamily: 'var(--mono)',
                background: 'var(--surface2)',
                padding: '1px 8px',
                borderRadius: 10,
              }}
            >
              {group.agents.length}
            </span>
          </button>
          {!collapsed.has(group.label) && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                gap: 12,
                paddingTop: 4,
              }}
            >
              {group.agents.map((agent) => (
                <AgentCard key={agent.role} agent={agent} onEdit={onEdit} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
