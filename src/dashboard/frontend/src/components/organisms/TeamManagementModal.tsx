'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { post, put, del } from '@/lib/api';
import { useAgentStore } from '@/stores/agentStore';
import { AlertDialog } from '@/components/molecules/AlertDialog';
import type { Agent } from '@/types';
import { MODEL_OPTIONS, DEFAULT_AGENT_MODEL } from '@/lib/constants';

interface TeamManagementModalProps {
  open: boolean;
  onClose: () => void;
  agent?: Agent;
}

const ROLE_PRESETS = [
  {
    role: 'product-owner',
    name: 'Product Owner',
    description: 'Defines product vision and priorities',
  },
  {
    role: 'scrum-master',
    name: 'Scrum Master',
    description: 'Facilitates sprint process and removes blockers',
  },
  {
    role: 'architect',
    name: 'Architect',
    description: 'Designs system architecture and technical direction',
  },
  {
    role: 'backend-developer',
    name: 'Backend Developer',
    description: 'Builds server-side logic and APIs',
  },
  {
    role: 'frontend-developer',
    name: 'Frontend Developer',
    description: 'Builds user interfaces and experiences',
  },
  {
    role: 'fullstack-developer',
    name: 'Fullstack Developer',
    description: 'Works across frontend and backend',
  },
  { role: 'qa', name: 'QA Engineer', description: 'Ensures quality and testing' },
  { role: 'devops', name: 'DevOps Engineer', description: 'Manages deployment and infrastructure' },
];

const inputStyle: React.CSSProperties = {
  background: 'var(--surface2)',
  border: '1px solid var(--border2)',
  borderRadius: 8,
  color: 'var(--text)',
  fontSize: 13,
  padding: '10px 14px',
  fontFamily: 'var(--font)',
  width: '100%',
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s',
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--text2)',
  marginBottom: 4,
  display: 'block',
};

export function TeamManagementModal({ open, onClose, agent }: TeamManagementModalProps) {
  const fetchAgents = useAgentStore((s) => s.fetchAgents);

  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [role, setRole] = useState(agent?.role ?? '');
  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [model, setModel] = useState(agent?.model ?? DEFAULT_AGENT_MODEL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const firstInputRef = useRef<HTMLInputElement>(null);
  const isEdit = Boolean(agent);

  // Reset form when opening/closing or changing agent
  useEffect(() => {
    if (open) {
      if (agent) {
        setRole(agent.role);
        setName(agent.name);
        setDescription(agent.description ?? '');
        setModel(agent.model ?? DEFAULT_AGENT_MODEL);
      } else {
        setRole('');
        setName('');
        setDescription('');
        setModel(DEFAULT_AGENT_MODEL);
      }
      setStep('form');
      setError(null);
      setTimeout(() => firstInputRef.current?.focus(), 50);
    }
  }, [open, agent]);

  // Escape key handling
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !deleteBusy) {
        if (showDeleteConfirm) {
          setShowDeleteConfirm(false);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, busy, deleteBusy, showDeleteConfirm, onClose]);

  function handlePresetClick(preset: (typeof ROLE_PRESETS)[0]) {
    setRole(preset.role);
    setName(preset.name);
    setDescription(preset.description);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!role.trim() || !name.trim()) {
      setError('Role and name are required');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      if (agent) {
        await put(`/api/agent/${encodeURIComponent(agent.role)}`, {
          name: name.trim(),
          description: description.trim() || null,
          model,
        });
      } else {
        await post('/api/agents', {
          role: role.trim(),
          name: name.trim(),
          description: description.trim() || null,
          model,
        });
      }
      await fetchAgents();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!agent) return;
    setDeleteBusy(true);
    try {
      await del(`/api/agent/${encodeURIComponent(agent.role)}`);
      await fetchAgents();
      setShowDeleteConfirm(false);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleteBusy(false);
    }
  }

  if (!open) return null;

  const selectedModel = MODEL_OPTIONS.find((m) => m.value === model);
  const accentColor = selectedModel?.color ?? '#60a5fa';

  return (
    <>
      {/* Main Modal */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(6px)',
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.15 }}
          onClick={(e) => e.stopPropagation()}
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 16,
            maxWidth: 560,
            width: '92vw',
            maxHeight: '85vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '24px 28px 0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: `${accentColor}18`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 16,
                  color: accentColor,
                }}
              >
                {isEdit ? '✏️' : '👤'}
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                  {isEdit ? 'Edit Team Member' : 'Add Team Member'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                  {isEdit ? 'Update agent configuration' : 'Create a new team member'}
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              disabled={busy}
              style={{
                background: 'none',
                border: 'none',
                fontSize: 18,
                color: 'var(--text3)',
                cursor: busy ? 'not-allowed' : 'pointer',
                padding: 4,
                borderRadius: 4,
                lineHeight: 1,
              }}
              onMouseEnter={(e) => {
                if (!busy) e.currentTarget.style.background = 'var(--surface2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'none';
              }}
            >
              ×
            </button>
          </div>

          {/* Content */}
          <div style={{ padding: '20px 28px 24px', overflowY: 'auto' }}>
            {/* Role Presets - only show for new agents */}
            {!isEdit && (
              <div style={{ marginBottom: 20 }}>
                <div
                  style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }}
                >
                  Quick Start Templates
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                  {ROLE_PRESETS.map((preset) => (
                    <button
                      key={preset.role}
                      type="button"
                      onClick={() => handlePresetClick(preset)}
                      disabled={busy}
                      style={{
                        padding: '10px 12px',
                        background: 'var(--surface2)',
                        border: '1px solid var(--border2)',
                        borderRadius: 8,
                        cursor: busy ? 'not-allowed' : 'pointer',
                        textAlign: 'left',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        if (!busy) {
                          e.currentTarget.style.background = 'var(--surface3)';
                          e.currentTarget.style.borderColor = accentColor;
                        }
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'var(--surface2)';
                        e.currentTarget.style.borderColor = 'var(--border2)';
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                        {preset.name}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
                        {preset.role}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Form */}
            <form
              onSubmit={handleSubmit}
              style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <label style={labelStyle}>
                    Role
                    {!isEdit && <span style={{ color: accentColor, marginLeft: 2 }}>*</span>}
                  </label>
                  <input
                    ref={firstInputRef}
                    type="text"
                    style={{
                      ...inputStyle,
                      ...(isEdit ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
                    }}
                    placeholder="e.g. backend-developer"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    required
                    disabled={isEdit || busy}
                  />
                </div>
                <div>
                  <label style={labelStyle}>
                    Name
                    <span style={{ color: accentColor, marginLeft: 2 }}>*</span>
                  </label>
                  <input
                    type="text"
                    style={inputStyle}
                    placeholder="e.g. Backend Developer"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    disabled={busy}
                  />
                </div>
              </div>

              <div>
                <label style={labelStyle}>Description</label>
                <textarea
                  style={{ ...inputStyle, resize: 'vertical', minHeight: 80 }}
                  placeholder="What does this team member do?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={busy}
                />
              </div>

              <div>
                <label style={labelStyle}>AI Model</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                  {MODEL_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setModel(opt.value)}
                      disabled={busy}
                      style={{
                        padding: '12px 10px',
                        background: model === opt.value ? `${opt.color}15` : 'var(--surface2)',
                        border: `1.5px solid ${model === opt.value ? opt.color : 'var(--border2)'}`,
                        borderRadius: 10,
                        cursor: busy ? 'not-allowed' : 'pointer',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        if (!busy && model !== opt.value) {
                          e.currentTarget.style.background = 'var(--surface3)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (model !== opt.value) {
                          e.currentTarget.style.background = 'var(--surface2)';
                        }
                      }}
                    >
                      <div
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          background: opt.color,
                          marginBottom: 6,
                        }}
                      />
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)' }}>
                        {opt.label}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
                        {opt.description}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {error && (
                <div
                  style={{
                    padding: '10px 14px',
                    background: 'rgba(239,68,68,0.1)',
                    border: '1px solid rgba(239,68,68,0.2)',
                    borderRadius: 8,
                    fontSize: 12,
                    color: '#f87171',
                  }}
                >
                  {error}
                </div>
              )}

              {/* Actions */}
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingTop: 8,
                }}
              >
                <div>
                  {isEdit && (
                    <button
                      type="button"
                      onClick={() => setShowDeleteConfirm(true)}
                      disabled={busy}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#f87171',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: busy ? 'not-allowed' : 'pointer',
                        padding: '8px 12px',
                        borderRadius: 6,
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        if (!busy) e.currentTarget.style.background = 'rgba(239,68,68,0.1)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'none';
                      }}
                    >
                      Delete Agent
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={busy}
                    style={{
                      background: 'none',
                      border: '1px solid var(--border2)',
                      borderRadius: 8,
                      padding: '8px 18px',
                      fontSize: 13,
                      color: 'var(--text2)',
                      cursor: busy ? 'not-allowed' : 'pointer',
                      fontFamily: 'var(--font)',
                      fontWeight: 500,
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !role.trim() || !name.trim()}
                    style={{
                      background: accentColor,
                      color: '#fff',
                      border: 'none',
                      borderRadius: 8,
                      padding: '8px 22px',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: busy || !role.trim() || !name.trim() ? 'not-allowed' : 'pointer',
                      fontFamily: 'var(--font)',
                      opacity: busy || !role.trim() || !name.trim() ? 0.5 : 1,
                      transition: 'opacity 0.15s',
                    }}
                  >
                    {busy ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Agent'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </motion.div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={showDeleteConfirm}
        title="Delete Team Member?"
        message={`Are you sure you want to delete "${agent?.name || agent?.role}"? This action cannot be undone.`}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
        confirmLabel="Delete"
        variant="danger"
      />
    </>
  );
}
