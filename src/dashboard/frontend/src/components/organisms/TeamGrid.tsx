'use client';

import { useState, useMemo, type CSSProperties } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useAgentStore } from '@/stores/agentStore';
import { AgentCard } from '@/components/molecules/AgentCard';
import { TeamManagementModal } from '@/components/organisms/TeamManagementModal';
import { cx } from '@/lib/utils';
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
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 p-5">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="h-[140px] bg-surface-2 rounded-card" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-y-auto">
      {/* Header bar with title and Add button */}
      <div className="flex justify-between items-center px-5 pt-0 pb-3">
        <div className="text-14 font-bold text-fg">Team Members</div>
        <button
          onClick={handleAdd}
          className="py-1.5 px-[14px] text-12 font-semibold bg-pill border-none rounded-pill text-pill-fg cursor-pointer flex items-center gap-1.5 [transition:opacity_.15s] hover:opacity-80"
        >
          <span className="text-[15px] leading-none">+</span> Add Member
        </button>
      </div>

      {/* Grouped grid or empty state */}
      {agents.length === 0 ? (
        <div className="p-[60px] text-center text-fg-3 text-14">
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
          color: 'var(--color-fg-3)',
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
          color: 'var(--color-fg-3)',
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
    <div className="flex-1 overflow-y-auto px-5 pt-0 pb-5">
      {groups.map((group) => (
        <div key={group.label} className="mb-4">
          <button
            onClick={() => toggle(group.label)}
            className="flex items-center gap-2 bg-transparent border-none cursor-pointer py-2 px-0 w-full font-body"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              className={cx(
                '[transition:transform_.2s] shrink-0',
                collapsed.has(group.label) ? '[transform:none]' : '[transform:rotate(90deg)]',
              )}
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
              style={{ '--c': group.color } as CSSProperties}
              className="w-2 h-2 rounded-[50%] bg-(--c) shrink-0"
            />
            <span className="text-13 font-bold text-fg">{group.label}</span>
            <span className="text-11 text-fg-3 font-code bg-surface-2 py-px px-2 rounded-[10px]">
              {group.agents.length}
            </span>
          </button>
          {!collapsed.has(group.label) && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 pt-1">
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
