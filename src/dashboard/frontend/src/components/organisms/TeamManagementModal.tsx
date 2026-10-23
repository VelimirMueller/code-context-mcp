'use client';

import { useState, useEffect, useRef, type CSSProperties } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { post, put, del } from '@/lib/api';
import { useAgentStore } from '@/stores/agentStore';
import { AlertDialog } from '@/components/molecules/AlertDialog';
import type { Agent } from '@/types';
import { cx } from '@/lib/utils';
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

const inputClass =
  'bg-surface-2 border border-line-2 rounded-[8px] text-fg text-13 py-[10px] px-[14px] font-body w-full [outline:none] box-border [transition:border-color_.15s]';

const labelClass = 'text-12 font-semibold text-fg-2 mb-1 block';

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
        style={
          {
            '--accent-c': accentColor,
            '--accent-bg': `${accentColor}18`,
          } as CSSProperties
        }
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-[rgba(0,0,0,0.6)] [backdrop-filter:blur(6px)]"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.15 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-surface border border-line rounded-[16px] max-w-[560px] w-[92vw] max-h-[85vh] overflow-hidden flex flex-col [box-shadow:0_24px_80px_rgba(0,0,0,0.5)]"
        >
          {/* Header */}
          <div className="px-7 pt-6 pb-0 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-[10px] bg-(--accent-bg) flex items-center justify-center text-16 text-(--accent-c)">
                {isEdit ? '✏️' : '👤'}
              </div>
              <div>
                <div className="text-[15px] font-bold text-fg">
                  {isEdit ? 'Edit Team Member' : 'Add Team Member'}
                </div>
                <div className="text-11 text-fg-3 mt-0.5">
                  {isEdit ? 'Update agent configuration' : 'Create a new team member'}
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              disabled={busy}
              className={cx(
                'bg-transparent border-none text-18 text-fg-3 p-1 rounded-[4px] leading-none enabled:hover:bg-surface-2',
                busy ? 'cursor-not-allowed' : 'cursor-pointer',
              )}
            >
              ×
            </button>
          </div>

          {/* Content */}
          <div className="px-7 pt-5 pb-6 overflow-y-auto">
            {/* Role Presets - only show for new agents */}
            {!isEdit && (
              <div className="mb-5">
                <div className="text-12 font-semibold text-fg-2 mb-2">Quick Start Templates</div>
                <div className="grid grid-cols-[repeat(2,1fr)] gap-2">
                  {ROLE_PRESETS.map((preset) => (
                    <button
                      key={preset.role}
                      type="button"
                      onClick={() => handlePresetClick(preset)}
                      disabled={busy}
                      className={cx(
                        'py-[10px] px-3 bg-surface-2 border border-line-2 rounded-[8px] text-left [transition:all_.15s] enabled:hover:bg-surface-3 enabled:hover:border-(--accent-c)',
                        busy ? 'cursor-not-allowed' : 'cursor-pointer',
                      )}
                    >
                      <div className="text-12 font-semibold text-fg">{preset.name}</div>
                      <div className="text-10 text-fg-3 mt-0.5">{preset.role}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="grid grid-cols-[1fr_1fr] gap-4">
                <div>
                  <label className={labelClass}>
                    Role
                    {!isEdit && <span className="text-(--accent-c) ml-0.5">*</span>}
                  </label>
                  <input
                    ref={firstInputRef}
                    type="text"
                    className={cx(inputClass, isEdit && 'opacity-60 cursor-not-allowed')}
                    placeholder="e.g. backend-developer"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    required
                    disabled={isEdit || busy}
                  />
                </div>
                <div>
                  <label className={labelClass}>
                    Name
                    <span className="text-(--accent-c) ml-0.5">*</span>
                  </label>
                  <input
                    type="text"
                    className={inputClass}
                    placeholder="e.g. Backend Developer"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    disabled={busy}
                  />
                </div>
              </div>

              <div>
                <label className={labelClass}>Description</label>
                <textarea
                  className={cx(inputClass, 'resize-y min-h-[80px]')}
                  placeholder="What does this team member do?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={busy}
                />
              </div>

              <div>
                <label className={labelClass}>AI Model</label>
                <div className="grid grid-cols-[repeat(2,1fr)] gap-2">
                  {MODEL_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setModel(opt.value)}
                      disabled={busy}
                      style={
                        { '--opt-c': opt.color, '--opt-bg': `${opt.color}15` } as CSSProperties
                      }
                      className={cx(
                        'py-3 px-[10px] border-[1.5px] rounded-[10px] [transition:all_.15s]',
                        model === opt.value
                          ? 'bg-(--opt-bg) border-(--opt-c)'
                          : 'bg-surface-2 border-line-2 enabled:hover:bg-surface-3',
                        busy ? 'cursor-not-allowed' : 'cursor-pointer',
                      )}
                    >
                      <div className="w-[10px] h-[10px] rounded-[50%] bg-(--opt-c) mb-1.5" />
                      <div className="text-11 font-bold text-fg">{opt.label}</div>
                      <div className="text-10 text-fg-3 mt-0.5">{opt.description}</div>
                    </button>
                  ))}
                </div>
              </div>

              {error && (
                <div className="py-[10px] px-[14px] bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.2)] rounded-[8px] text-12 text-red">
                  {error}
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 justify-between items-center pt-2">
                <div>
                  {isEdit && (
                    <button
                      type="button"
                      onClick={() => setShowDeleteConfirm(true)}
                      disabled={busy}
                      className={cx(
                        'bg-transparent border-none text-red text-12 font-semibold py-2 px-3 rounded-[6px] [transition:background_.15s] enabled:hover:bg-[rgba(239,68,68,0.1)]',
                        busy ? 'cursor-not-allowed' : 'cursor-pointer',
                      )}
                    >
                      Delete Agent
                    </button>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={busy}
                    className={cx(
                      'bg-transparent border border-line-2 rounded-[8px] py-2 px-[18px] text-13 text-fg-2 font-body font-medium',
                      busy ? 'cursor-not-allowed' : 'cursor-pointer',
                    )}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !role.trim() || !name.trim()}
                    className={cx(
                      'bg-(--accent-c) text-[#fff] border-none rounded-[8px] py-2 px-[22px] text-13 font-semibold font-body [transition:opacity_.15s]',
                      busy || !role.trim() || !name.trim()
                        ? 'cursor-not-allowed opacity-50'
                        : 'cursor-pointer opacity-100',
                    )}
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
