'use client';

import { useState, useRef, useEffect, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { cardHover } from '@/lib/motion';
import { put, del } from '@/lib/api';
import { useAgentStore } from '@/stores/agentStore';
import { AlertDialog } from '@/components/molecules/AlertDialog';
import { MODEL_OPTIONS, MODEL_COLORS, MODEL_SHORT_LABELS } from '@/lib/constants';
import { cx } from '@/lib/utils';
import type { Agent } from '@/types';

interface AgentCardProps {
  agent: Agent;
  onEdit: (agent: Agent) => void;
}

function healthStatus(agent: Agent): 'active' | 'idle' | 'blocked' {
  if (agent.blocked_tickets > 0) return 'blocked';
  if (agent.active_tickets > 0 || agent.done_tickets > 0) return 'active';
  return 'idle';
}

const healthColor: Record<string, string> = {
  active: 'var(--color-accent)',
  idle: 'var(--color-orange)',
  blocked: 'var(--color-red)',
};

const iconBtnClass =
  'bg-transparent border-none cursor-pointer p-0.5 text-13 leading-none text-fg-3 rounded-[4px] flex items-center justify-center w-[22px] h-[22px] [transition:background_.15s,color_.15s] hover:bg-surface-2';

export function AgentCard({ agent, onEdit }: AgentCardProps) {
  const health = healthStatus(agent);
  const moodScore = agent.mood ?? 50;
  const moodColor =
    moodScore >= 60
      ? 'var(--color-green)'
      : moodScore >= 40
        ? 'var(--color-orange)'
        : 'var(--color-red)';
  const fetchAgents = useAgentStore((s) => s.fetchAgents);

  const [busy, setBusy] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modelDropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [modelDropdownOpen]);

  async function handleDelete() {
    setDeleteBusy(true);
    try {
      await del(`/api/agent/${encodeURIComponent(agent.role)}`);
      await fetchAgents();
      setShowDeleteConfirm(false);
    } finally {
      setDeleteBusy(false);
    }
  }

  async function handleModelChange(model: string) {
    setModelDropdownOpen(false);
    setBusy(true);
    try {
      await put(`/api/agent/${encodeURIComponent(agent.role)}`, { model });
      await fetchAgents();
    } finally {
      setBusy(false);
    }
  }

  const modelColor = MODEL_COLORS[agent.model] ?? 'var(--color-fg-3)';

  return (
    <>
      <motion.div
        whileHover={cardHover}
        layout
        className="py-[14px] px-4 bg-surface border border-line rounded-card relative"
      >
        {/* Action buttons: edit + delete */}
        <div className="absolute top-2 right-2 flex gap-0.5">
          <button
            onClick={() => onEdit(agent)}
            disabled={busy}
            title="Edit agent"
            className={cx(iconBtnClass, 'hover:text-fg')}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              <path d="m15 5 4 4" />
            </svg>
          </button>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={busy}
            title="Delete agent"
            className={cx(iconBtnClass, 'hover:text-red')}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Header: role + health dot + mood emoji */}
        <div className="flex justify-between items-center mb-1.5 pr-[50px]">
          <span className="text-13 font-semibold text-fg">{agent.name || agent.role}</span>
          <div className="flex items-center gap-1.5">
            {/* Health dot */}
            <div
              title={health}
              style={{ '--c': healthColor[health] } as CSSProperties}
              className="w-2 h-2 rounded-[50%] bg-(--c) [box-shadow:0_0_6px_var(--c)]"
            />
            <span className="text-16">{agent.mood_emoji || '\u{1F610}'}</span>
          </div>
        </div>

        {/* Description */}
        <div className="text-12 text-fg-2 mb-2 leading-[1.5]">
          {agent.description || 'No description'}
        </div>

        {/* Model badge (clickable) + mood label */}
        <div className="flex justify-between items-center mb-1.5">
          <div ref={dropdownRef} className="relative">
            <button
              onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
              disabled={busy}
              style={{ '--c': modelColor } as CSSProperties}
              className="text-10 text-[#fff] font-code bg-(--c) py-0.5 px-2 rounded-[4px] border-none cursor-pointer font-semibold tracking-[0.02em]"
              title="Click to change model"
            >
              {MODEL_SHORT_LABELS[agent.model] || agent.model || 'default'}
            </button>

            {modelDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 bg-surface border border-line rounded-card [box-shadow:0_4px_12px_rgba(0,0,0,.3)] z-[100] min-w-[140px] overflow-hidden">
                {MODEL_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleModelChange(opt.value)}
                    style={{ '--c': MODEL_COLORS[opt.value] } as CSSProperties}
                    className={cx(
                      'flex items-center gap-2 w-full py-[6px] px-[10px] text-11 border-none cursor-pointer text-left [font-family:inherit]',
                      agent.model === opt.value
                        ? 'text-[#fff] bg-(--c)'
                        : 'text-fg bg-transparent hover:bg-surface-2',
                    )}
                  >
                    <span className="w-2 h-2 rounded-[50%] bg-(--c) shrink-0" />
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <span
            style={{ '--c': moodColor } as CSSProperties}
            className="text-11 text-(--c) font-semibold"
          >
            {agent.mood_label || 'neutral'} ({moodScore})
          </span>
        </div>

        {/* Mood progress bar */}
        <div className="h-[3px] bg-line rounded-[2px] overflow-hidden mb-1.5">
          <div
            style={{ width: `${moodScore}%`, '--c': moodColor } as CSSProperties}
            className="h-full bg-(--c) [transition:width_.3s]"
          />
        </div>

        {/* Ticket counts */}
        <div className="text-11 text-fg-3">
          Done: {agent.done_tickets ?? 0} | Active: {agent.active_tickets ?? 0} | Blocked:{' '}
          {agent.blocked_tickets ?? 0}
        </div>
      </motion.div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={showDeleteConfirm}
        title="Delete Team Member?"
        message={`Are you sure you want to delete "${agent.name || agent.role}"? This action cannot be undone.`}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
        confirmLabel="Delete"
        variant="danger"
      />
    </>
  );
}
