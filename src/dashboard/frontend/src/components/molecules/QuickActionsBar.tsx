'use client';

import React from 'react';
import { Breadcrumb } from './Breadcrumb';
import { cx } from '@/lib/utils';

interface QuickAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  count?: number;
  highlight?: boolean;
  onClick: () => void;
}

interface QuickActionsBarProps {
  actions: QuickAction[];
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  breadcrumbItems?: Array<{ label: string; path?: string }>;
}

export function QuickActionsBar({
  actions,
  searchQuery,
  onSearchChange,
  breadcrumbItems,
}: QuickActionsBarProps) {
  return (
    <div className="flex h-10 items-center justify-between gap-4 border-b border-b-line bg-bg px-7">
      <div className="flex items-center gap-2 text-12 text-fg-3">
        {breadcrumbItems ? (
          <Breadcrumb items={breadcrumbItems} />
        ) : (
          <>
            <span className="font-medium">Dashboard</span>
            <span className="text-fg-3" data-testid="breadcrumb-separator">
              &gt;
            </span>
            <span className="font-medium text-fg-2">Sprint Board (Active)</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        {actions.map((action) => (
          <button
            key={action.id}
            className={cx(
              'flex min-h-[32px] cursor-pointer items-center gap-[6px] rounded-pill border bg-surface px-3 py-[6px] font-body text-12 font-medium text-fg transition-all hover:bg-surface-2',
              action.highlight ? 'animate-[pulse_2s_infinite] border-red' : 'border-line',
            )}
            onClick={action.onClick}
            aria-label={`${action.label}${action.count !== undefined ? ` (${action.count})` : ''}`}
          >
            <span className="text-14" aria-hidden="true">
              {action.icon}
            </span>
            <span className="text-12">{action.label}</span>
            {action.count !== undefined && action.count > 0 && (
              <span
                className={cx(
                  'flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] px-[5px] text-10 font-semibold',
                  action.highlight ? 'bg-red text-[white]' : 'bg-surface-3 text-fg-2',
                )}
              >
                {action.count}
              </span>
            )}
          </button>
        ))}
        {onSearchChange && (
          <div>
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              aria-label="Search tickets"
            />
          </div>
        )}
      </div>
    </div>
  );
}
