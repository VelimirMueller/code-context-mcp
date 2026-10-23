import React, { useEffect, useRef } from 'react';
import { cx } from '@/lib/utils';

const confirmClasses: Record<'danger' | 'warning', string> = {
  danger: 'bg-[#f87171] hover:bg-[#dc2626]',
  warning: 'bg-[#fbbf24] hover:bg-[#d97706]',
};

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

  return (
    <div
      onClick={onCancel}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[rgba(0,0,0,0.55)] [backdrop-filter:blur(4px)]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-line rounded-card py-6 px-7 max-w-[420px] w-[90vw] flex flex-col gap-4 [box-shadow:0_20px_60px_rgba(0,0,0,0.4)]"
      >
        <div className="text-16 font-bold text-fg">{title}</div>
        <div className="text-13 text-fg-2 leading-[1.6]">{message}</div>
        <div className="flex gap-2 justify-end mt-1">
          <button
            onClick={onCancel}
            className="bg-transparent border border-line-2 rounded-[8px] py-2 px-[18px] text-13 text-fg-2 cursor-pointer font-body font-medium"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={cx(
              'text-[#fff] border-none rounded-[8px] py-2 px-[18px] text-13 font-semibold cursor-pointer font-body',
              confirmClasses[variant],
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
