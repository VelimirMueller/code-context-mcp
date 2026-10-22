'use client';

import { useEffect, useCallback } from 'react';
import { useUIStore, type PageType } from '@/stores/uiStore';
import { useFileStore } from '@/stores/fileStore';
import { useSprintStore } from '@/stores/sprintStore';

// Legacy page name mapping (old -> new PageType)
const legacyPageMapping: Record<string, PageType> = {
  explorer: 'code',
  sprint: 'dashboard',
};

// All valid page types
const validPages: PageType[] = ['dashboard', 'code', 'planning', 'team', 'retro', 'benchmark'];

// Default tabs per page
const defaultTabs: Record<string, string> = {
  dashboard: 'board',
  code: 'files',
  planning: 'vision',
  team: 'grid',
  retro: 'insights',
  benchmark: 'overview',
};

interface ParsedHash {
  page: PageType;
  tab: string;
  resourceId: number | null;
}

function parseHash(hash: string): ParsedHash {
  const clean = hash.replace(/^#/, '');
  const parts = clean.split('/');

  const rawPage = parts[0] || 'dashboard';

  // Map legacy names to new PageType, or use as-is if already valid
  const page: PageType = legacyPageMapping[rawPage] || (validPages.includes(rawPage as PageType) ? rawPage as PageType : 'dashboard');

  const tab = parts[1] || defaultTabs[page] || 'board';
  const id = parts[2];

  return {
    page,
    tab,
    resourceId: id ? parseInt(id, 10) : null,
  };
}

function buildHash(page: string, tab: string, resourceId?: number | null): string {
  const base = `#${page}/${tab}`;
  return resourceId != null ? `${base}/${resourceId}` : base;
}

export function useHashRouter() {
  const activePage = useUIStore((s) => s.activePage);
  const activeTab = useUIStore((s) => s.activeTab);
  const setPage = useUIStore((s) => s.setPage);
  const setTab = useUIStore((s) => s.setTab);
  const selectedFileId = useFileStore((s) => s.selectedFileId);
  const selectFile = useFileStore((s) => s.selectFile);
  const selectedSprintId = useSprintStore((s) => s.selectedSprintId);
  const selectSprint = useSprintStore((s) => s.selectSprint);

  // Hash -> state: read hash on mount and popstate
  const syncFromHash = useCallback(() => {
    const { page, tab, resourceId } = parseHash(window.location.hash);

    if (page !== useUIStore.getState().activePage) {
      setPage(page);
    }
    if (tab !== useUIStore.getState().activeTab) {
      setTab(tab);
    }

    if (resourceId !== null) {
      if (page === 'code' && resourceId !== useFileStore.getState().selectedFileId) {
        selectFile(resourceId);
      }
      if (page === 'dashboard' && resourceId !== useSprintStore.getState().selectedSprintId) {
        // Only select if sprint exists in loaded sprints, otherwise let auto-select handle it
        const sprints = useSprintStore.getState().sprints;
        if (sprints.length === 0 || sprints.some((s) => s.id === resourceId)) {
          selectSprint(resourceId);
        }
      }
    }
  }, [setPage, setTab, selectFile, selectSprint]);

  useEffect(() => {
    syncFromHash();
    window.addEventListener('popstate', syncFromHash);
    return () => window.removeEventListener('popstate', syncFromHash);
  }, [syncFromHash]);

  // State -> hash: write hash when state changes
  useEffect(() => {
    let resourceId: number | null = null;
    if (activePage === 'code') resourceId = selectedFileId;
    if (activePage === 'dashboard') resourceId = selectedSprintId;

    const newHash = buildHash(activePage, activeTab, resourceId);
    if (window.location.hash !== newHash) {
      window.history.pushState(null, '', newHash);
    }
  }, [activePage, activeTab, selectedFileId, selectedSprintId]);
}
