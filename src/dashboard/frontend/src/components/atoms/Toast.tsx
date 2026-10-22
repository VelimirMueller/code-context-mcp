import { useEffect } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cx } from '@/lib/utils';

type ToastType = 'success' | 'error' | 'warning';

interface ToastProps {
  message: string;
  type: ToastType;
  onClose: () => void;
}

/** Border and icon colour per type. */
const typeClasses: Record<ToastType, { border: string; icon: string }> = {
  success: { border: 'border-green', icon: 'text-green' },
  error: { border: 'border-red', icon: 'text-red' },
  warning: { border: 'border-orange', icon: 'text-orange' },
};

const ICONS: Record<ToastType, string> = { success: '✓', error: '✕', warning: '⚠' };

export function Toast({ message, type, onClose }: ToastProps) {
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const timer = setTimeout(onClose, 5000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <motion.div
      initial={reduceMotion ? { opacity: 1, y: 0, x: 0 } : { opacity: 0, y: 20, x: 20 }}
      animate={{ opacity: 1, y: 0, x: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 20, x: 20 }}
      transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 400, damping: 30 }}
      className={cx(
        'flex max-w-[360px] min-w-[220px] cursor-pointer items-center gap-[10px] rounded-[10px] border bg-surface px-4 py-[10px] [box-shadow:0_4px_24px_rgba(0,0,0,0.4)]',
        typeClasses[type].border,
      )}
      onClick={onClose}
      role="alert"
      aria-live="assertive"
    >
      <span className={cx('text-16 leading-none', typeClasses[type].icon)}>{ICONS[type]}</span>
      <span className="flex-1 text-13 text-fg">{message}</span>
    </motion.div>
  );
}
