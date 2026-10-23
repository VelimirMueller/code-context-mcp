import type { CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { cardHover } from '@/lib/motion';
import { cx } from '@/lib/utils';

interface BentoCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  items?: string[];
  borderColor: string;
  iconBg: string;
  wide?: boolean;
  children?: React.ReactNode;
}

export function BentoCard({
  icon,
  title,
  subtitle,
  items,
  borderColor,
  iconBg,
  wide,
  children,
}: BentoCardProps) {
  return (
    <motion.div
      whileHover={cardHover}
      layout
      style={{ '--c': borderColor } as CSSProperties}
      className={cx(
        'bg-surface border border-line rounded-card border-t-[3px] border-t-(--c) p-4 flex flex-col gap-[10px]',
        wide && '[grid-column:span_2]',
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-[10px]">
        <div
          style={{ '--c': iconBg } as CSSProperties}
          className="w-9 h-9 rounded-[8px] bg-(--c) flex items-center justify-center text-18 shrink-0"
        >
          {icon}
        </div>
        <div>
          <div className="text-13 font-semibold text-fg leading-[1.3]">{title}</div>
          <div className="text-11 text-fg-3 mt-0.5">{subtitle}</div>
        </div>
      </div>

      {/* Bullet list */}
      {items && items.length > 0 && (
        <ul className="list-none m-0 p-0 flex flex-col gap-[5px]">
          {items.map((item, i) => (
            <li key={i} className="flex gap-2 items-start text-12 text-fg-2 leading-[1.5]">
              <span className="w-[5px] h-[5px] rounded-[50%] bg-(--c) shrink-0 mt-[6px]" />
              {item}
            </li>
          ))}
        </ul>
      )}

      {children}
    </motion.div>
  );
}
