'use client';

import { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { cardHover } from '@/lib/motion';
import { put, del } from '@/lib/api';
import { useAgentStore } from '@/stores/agentStore';
import { AlertDialog } from '@/components/molecules/AlertDialog';
import { MODEL_OPTIONS, MODEL_COLORS, MODEL_SHORT_LABELS } from '@/lib/constants';
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
  active: 'var(--accent)',
  idle: 'var(--orange)',
  blocked: 'var(--red)',
};

const iconBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 2,
  fontSize: 13,
  lineHeight: 1,
  color: 'var(--text3)',
  borderRadius: 4,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  transition: 'background .15s, color .15s',
};

export function AgentCard({ agent, onEdit }: AgentCardProps) {
  const health = healthStatus(agent);
  const moodScore = agent.mood ?? 50;
  const moodColor =
    moodScore >= 60 ? 'var(--green)' : moodScore >= 40 ? 'var(--orange)' : 'var(--red)';
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

  const modelColor = MODEL_COLORS[agent.model] ?? 'var(--text3)';

  return (
    <>
      <motion.div
        whileHover={cardHover}
        layout
        style={{
          padding: '14px 16px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          position: 'relative',
        }}
      >
        {/* Action buttons: edit + delete */}
        <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 2 }}>
          <button
            onClick={() => onEdit(agent)}
            disabled={busy}
            title="Edit agent"
            style={iconBtnStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--surface2)';
              e.currentTarget.style.color = 'var(--text)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'none';
              e.currentTarget.style.color = 'var(--text3)';
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              <path d="m15 5 4 4" />
            </svg>
          </button>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            disabled={busy}
            title="Delete agent"
            style={iconBtnStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--surface2)';
              e.currentTarget.style.color = 'var(--red)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'none';
              e.currentTarget.style.color = 'var(--text3)';
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Header: role + health dot + mood emoji */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 6,
            paddingRight: 50,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            {agent.name || agent.role}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* Health dot */}
            <div
              title={health}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: healthColor[health],
                boxShadow: `0 0 6px ${healthColor[health]}`,
              }}
            />
            <span style={{ fontSize: 16 }}>{agent.mood_emoji || '\u{1F610}'}</span>
          </div>
        </div>

        {/* Description */}
        <div
          style={{
            fontSize: 12,
            color: 'var(--text2)',
            marginBottom: 8,
            lineHeight: 1.5,
          }}
        >
          {agent.description || 'No description'}
        </div>

        {/* Model badge (clickable) + mood label */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 6,
          }}
        >
          <div ref={dropdownRef} style={{ position: 'relative' }}>
            <button
              onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
              disabled={busy}
              style={{
                fontSize: 10,
                color: '#fff',
                fontFamily: 'var(--mono)',
                background: modelColor,
                padding: '2px 8px',
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                fontWeight: 600,
                letterSpacing: '0.02em',
              }}
              title="Click to change model"
            >
              {MODEL_SHORT_LABELS[agent.model] || agent.model || 'default'}
            </button>

            {modelDropdownOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: 4,
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  boxShadow: '0 4px 12px rgba(0,0,0,.3)',
                  zIndex: 100,
                  minWidth: 140,
                  overflow: 'hidden',
                }}
              >
                {MODEL_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleModelChange(opt.value)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '6px 10px',
                      fontSize: 11,
                      color: agent.model === opt.value ? '#fff' : 'var(--text)',
                      background: agent.model === opt.value ? MODEL_COLORS[opt.value] : 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: 'inherit',
                    }}
                    onMouseEnter={(e) => {
                      if (agent.model !== opt.value) {
                        e.currentTarget.style.background = 'var(--surface2)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (agent.model !== opt.value) {
                        e.currentTarget.style.background = 'transparent';
                      }
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: MODEL_COLORS[opt.value],
                        flexShrink: 0,
                      }}
                    />
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <span style={{ fontSize: 11, color: moodColor, fontWeight: 600 }}>
            {agent.mood_label || 'neutral'} ({moodScore})
          </span>
        </div>

        {/* Mood progress bar */}
        <div
          style={{
            height: 3,
            background: 'var(--border)',
            borderRadius: 2,
            overflow: 'hidden',
            marginBottom: 6,
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${moodScore}%`,
              background: moodColor,
              transition: 'width .3s',
            }}
          />
        </div>

        {/* Ticket counts */}
        <div style={{ fontSize: 11, color: 'var(--text3)' }}>
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
