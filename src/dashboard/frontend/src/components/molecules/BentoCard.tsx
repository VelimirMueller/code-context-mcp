import { motion } from 'framer-motion';
import { cardHover } from '@/lib/motion';

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
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        borderTop: `3px solid ${borderColor}`,
        padding: '16px',
        gridColumn: wide ? 'span 2' : undefined,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: iconBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3 }}>
            {title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{subtitle}</div>
        </div>
      </div>

      {/* Bullet list */}
      {items && items.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
          }}
        >
          {items.map((item, i) => (
            <li
              key={i}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                fontSize: 12,
                color: 'var(--text2)',
                lineHeight: 1.5,
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: borderColor,
                  flexShrink: 0,
                  marginTop: 6,
                }}
              />
              {item}
            </li>
          ))}
        </ul>
      )}

      {children}
    </motion.div>
  );
}
