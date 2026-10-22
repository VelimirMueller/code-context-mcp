'use client';

import React from 'react';
import { Breadcrumb } from './Breadcrumb';

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

export function QuickActionsBar({ actions, searchQuery, onSearchChange, breadcrumbItems }: QuickActionsBarProps) {
  return (
    <div className="quick-actions-bar">
      <div className="quick-actions-breadcrumb">
        {breadcrumbItems ? (
          <Breadcrumb items={breadcrumbItems} />
        ) : (
          <>
            <span className="breadcrumb-text">Dashboard</span>
            <span className="breadcrumb-separator">&gt;</span>
            <span className="breadcrumb-current">Sprint Board (Active)</span>
          </>
        )}
      </div>
      <div className="quick-actions-buttons">
        {actions.map((action) => (
          <button
            key={action.id}
            className={`quick-action-btn ${action.highlight ? 'highlight' : ''}`}
            onClick={action.onClick}
            aria-label={`${action.label}${action.count !== undefined ? ` (${action.count})` : ''}`}
          >
            <span className="action-icon" aria-hidden="true">
              {action.icon}
            </span>
            <span className="action-label">{action.label}</span>
            {action.count !== undefined && action.count > 0 && (
              <span className="action-count">{action.count}</span>
            )}
          </button>
        ))}
        {onSearchChange && (
          <div className="quick-search">
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="search-input"
              aria-label="Search tickets"
            />
          </div>
        )}
      </div>
    </div>
  );
}
