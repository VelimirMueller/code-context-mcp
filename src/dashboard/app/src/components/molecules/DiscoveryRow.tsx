import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Discovery } from '@/types';

interface Props {
  discovery: Discovery;
  onLinkTicket?: (discoveryId: number) => void;
  onClickTicket?: (ticketId: number) => void;
}

const STATUS_COLORS: Record<string, string> = {
  discovered: '#6b6b84', planned: '#60a5fa', implemented: '#10b981', dropped: '#f87171',
};

const PRIORITY_COLORS: Record<string, string> = {
  P0: '#f87171', P1: '#fbbf24', P2: '#60a5fa', P3: '#6b6b84',
};

const CATEGORY_COLORS: Record<string, string> = {
  architecture: '#818cf8', ux: '#ec4899', performance: '#10b981',
  testing: '#fbbf24', integration: '#60a5fa', general: '#6b6b84',
};

export function DiscoveryRow({ discovery, onLinkTicket, onClickTicket }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.15s' }}
      onClick={() => setExpanded(!expanded)}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', padding: '2px 6px', borderRadius: 4, background: (STATUS_COLORS[discovery.status] || '#6b6b84') + '22', color: STATUS_COLORS[discovery.status] || '#6b6b84' }}>
          {discovery.status}
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, color: PRIORITY_COLORS[discovery.priority] || '#6b6b84', padding: '1px 6px', borderRadius: 4, border: `1px solid ${PRIORITY_COLORS[discovery.priority] || '#6b6b84'}` }}>
          {discovery.priority}
        </span>
        <span style={{ flex: 1, fontSize: 13, color: 'var(--text-1)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: expanded ? 'normal' : 'nowrap' }}>
          {discovery.finding}
        </span>
        {discovery.ticket_title && discovery.implementation_ticket_id ? (
          <span
            onClick={(e) => { e.stopPropagation(); onClickTicket?.(discovery.implementation_ticket_id!); }}
            style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'var(--surface-3)', color: 'var(--accent)', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            T-{discovery.implementation_ticket_id}: {discovery.ticket_title}
          </span>
        ) : (
          onLinkTicket && (
            <span
              onClick={(e) => { e.stopPropagation(); onLinkTicket(discovery.id); }}
              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: '1px dashed var(--border)', color: 'var(--text-3)', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              Link ticket
            </span>
          )
        )}
        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: (CATEGORY_COLORS[discovery.category] || '#6b6b84') + '22', color: CATEGORY_COLORS[discovery.category] || '#6b6b84' }}>
          {discovery.category}
        </span>
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: 'hidden', marginTop: 8, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}
          >
            <div>{discovery.finding}</div>
            {discovery.resolution_plan && (
              <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 6, borderLeft: '3px solid var(--accent)' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-1)', marginBottom: 4 }}>Resolution Plan</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{discovery.resolution_plan}</div>
              </div>
            )}
            {discovery.drop_reason && (
              <div style={{ marginTop: 4, color: '#f87171' }}>Drop reason: {discovery.drop_reason}</div>
            )}
            <div style={{ marginTop: 4, opacity: 0.6 }}>
              By: {discovery.created_by || '\u2014'} | {discovery.created_at}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
