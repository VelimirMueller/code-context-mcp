import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePlanningStore } from '@/stores/planningStore';
import { MarkdownRenderer } from '@/components/molecules/MarkdownRenderer';

function formatTimestamp(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
    if (isNaN(d.getTime())) return iso;
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

export function VisionEditor() {
  const vision = usePlanningStore((s) => s.vision);
  const visionUpdatedAt = usePlanningStore((s) => s.visionUpdatedAt);
  const loading = usePlanningStore((s) => s.loading.vision);
  const updateVision = usePlanningStore((s) => s.updateVision);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEdit = () => {
    setDraft(vision ?? '');
    setError(null);
    setEditing(true);
  };

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      await updateVision(draft);
      setEditing(false);
    } catch {
      setError('Failed to save vision. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = () => {
    setEditing(false);
    setDraft('');
    setError(null);
  };

  if (loading && vision === null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8,
              background: 'var(--surface2)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              animation: 'pulse 1.5s ease-in-out infinite',
            }} />
            <div style={{ width: 120, height: 18, background: 'var(--surface2)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} />
          </div>
        </div>
        <div style={{ height: 200, background: 'var(--surface2)', borderRadius: 12, animation: 'pulse 1.5s ease-in-out infinite' }} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'linear-gradient(135deg, var(--accent), #4f46e5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
          </div>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', margin: 0, lineHeight: 1.2 }}>
              Product Vision
            </h2>
            {visionUpdatedAt && (
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2, fontFamily: 'var(--mono)' }}>
                Updated {formatTimestamp(visionUpdatedAt)}
              </div>
            )}
          </div>
        </div>
        {!editing && (
          <button
            onClick={startEdit}
            style={{
              background: 'var(--surface2)',
              border: '1px solid var(--border2)',
              borderRadius: 8,
              color: 'var(--text2)',
              fontSize: 13,
              padding: '7px 16px',
              cursor: 'pointer',
              fontFamily: 'var(--font)',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all .15s',
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget;
              el.style.background = 'var(--surface3)';
              el.style.borderColor = 'var(--border)';
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget;
              el.style.background = 'var(--surface2)';
              el.style.borderColor = 'var(--border2)';
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              <path d="m15 5 4 4" />
            </svg>
            Edit
          </button>
        )}
      </div>

      <AnimatePresence mode="wait">
        {editing ? (
          <motion.div
            key="editor"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
          >
            {/* Editor label */}
            <div style={{
              fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase',
              letterSpacing: '0.05em', fontFamily: 'var(--mono)',
            }}>
              Markdown Editor
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {/* Left: textarea */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={busy}
                  placeholder="Write your product vision in Markdown..."
                  style={{
                    background: 'var(--surface2)',
                    border: '1px solid var(--border2)',
                    borderRadius: 10,
                    color: 'var(--text)',
                    fontSize: 13,
                    padding: '12px 14px',
                    fontFamily: 'var(--mono)',
                    resize: 'vertical',
                    minHeight: 340,
                    lineHeight: 1.7,
                    outline: 'none',
                    width: '100%',
                    transition: 'border-color .2s',
                  }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border2)'; }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                    Markdown supported
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                    {draft.length} chars
                  </div>
                </div>
              </div>
              {/* Right: live preview */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: '12px 14px',
                    minHeight: 340,
                    overflowY: 'auto',
                  }}
                >
                  {draft ? (
                    <MarkdownRenderer content={draft} />
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text3)', fontSize: 13, fontStyle: 'italic' }}>
                      Preview will appear here...
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                  Live preview
                </div>
              </div>
            </div>

            {error && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                style={{
                  color: 'var(--red, #f87171)',
                  fontSize: 12,
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: 8,
                  padding: '8px 12px',
                  fontFamily: 'var(--mono)',
                }}
              >
                {error}
              </motion.div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleSave}
                disabled={busy}
                style={{
                  background: busy ? 'var(--surface3)' : 'var(--accent)',
                  color: busy ? 'var(--text3)' : '#000',
                  border: 'none',
                  borderRadius: 8,
                  padding: '8px 20px',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: busy ? 'not-allowed' : 'pointer',
                  fontFamily: 'var(--font)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  transition: 'all .15s',
                }}
              >
                {busy && (
                  <span style={{
                    width: 12, height: 12, border: '2px solid transparent',
                    borderTopColor: '#000', borderRadius: '50%', animation: 'spin 0.6s linear infinite',
                    display: 'inline-block',
                  }} />
                )}
                {busy ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={handleCancel}
                disabled={busy}
                style={{
                  background: 'none',
                  border: '1px solid var(--border2)',
                  borderRadius: 8,
                  padding: '8px 16px',
                  fontSize: 13,
                  color: 'var(--text2)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font)',
                  transition: 'all .15s',
                }}
              >
                Cancel
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="display"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            <div
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                overflow: 'hidden',
              }}
            >
              {/* Card accent top bar */}
              <div style={{
                height: 3,
                background: 'linear-gradient(90deg, var(--accent), #4f46e5, var(--accent))',
                backgroundSize: '200% 100%',
              }} />

              <div style={{ padding: '20px 24px', minHeight: 120 }}>
                {vision ? (
                  <MarkdownRenderer content={vision} />
                ) : (
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '40px 0',
                    gap: 12,
                  }}>
                    <div style={{
                      width: 48, height: 48, borderRadius: 12,
                      background: 'var(--surface2)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </div>
                    <div style={{ color: 'var(--text3)', fontSize: 14, textAlign: 'center' }}>
                      No product vision defined yet.
                    </div>
                    <button
                      onClick={startEdit}
                      style={{
                        background: 'none',
                        border: '1px dashed var(--border2)',
                        borderRadius: 8,
                        color: 'var(--text3)',
                        fontSize: 13,
                        padding: '8px 20px',
                        cursor: 'pointer',
                        fontFamily: 'var(--font)',
                        transition: 'all .15s',
                      }}
                    >
                      Click to add your vision
                    </button>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
