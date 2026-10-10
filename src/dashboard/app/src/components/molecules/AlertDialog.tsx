import React, { useEffect, useRef } from 'react';

interface AlertDialogProps {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  variant?: 'danger' | 'warning';
}

export function AlertDialog({
  open,
  title,
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  variant = 'danger',
}: AlertDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      confirmRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onCancel]);

  if (!open) return null;

  const confirmBg = variant === 'danger' ? '#f87171' : '#fbbf24';
  const confirmHoverBg = variant === 'danger' ? '#dc2626' : '#d97706';

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(4px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: '24px 28px',
          maxWidth: 420,
          width: '90vw',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
          {title}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>
          {message}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button
            onClick={onCancel}
            style={{
              background: 'none',
              border: '1px solid var(--border2)',
              borderRadius: 8,
              padding: '8px 18px',
              fontSize: 13,
              color: 'var(--text2)',
              cursor: 'pointer',
              fontFamily: 'var(--font)',
              fontWeight: 500,
            }}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            onMouseEnter={(e) => { e.currentTarget.style.background = confirmHoverBg; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = confirmBg; }}
            style={{
              background: confirmBg,
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '8px 18px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'var(--font)',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
