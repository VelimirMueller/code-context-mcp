import { useState, useEffect, useMemo } from 'react';
import { useFileStore } from '@/stores/fileStore';
import { useUIStore } from '@/stores/uiStore';

export function useSearch() {
  const files = useFileStore((s) => s.files);
  const searchQuery = useUIStore((s) => s.searchQuery);
  const setSearch = useUIStore((s) => s.setSearch);
  const searchFocused = useUIStore((s) => s.searchFocused);
  const setSearchFocused = useUIStore((s) => s.setSearchFocused);

  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const filteredFiles = useMemo(() => {
    if (!debouncedQuery) return files;
    const q = debouncedQuery.toLowerCase();
    return files.filter(
      (f) =>
        f.path.toLowerCase().includes(q) ||
        f.language.toLowerCase().includes(q) ||
        (f.summary && f.summary.toLowerCase().includes(q)),
    );
  }, [files, debouncedQuery]);

  return {
    searchQuery,
    setSearch,
    searchFocused,
    setSearchFocused,
    filteredFiles,
    debouncedQuery,
  };
}
