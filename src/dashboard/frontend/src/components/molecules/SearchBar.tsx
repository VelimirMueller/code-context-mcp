import React, { useEffect, useRef } from 'react';
import { useSearch } from '@/hooks/useSearch';

export function SearchBar() {
  const { searchQuery, setSearch, searchFocused, setSearchFocused } = useSearch();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchFocused && inputRef.current) {
      inputRef.current.focus();
    }
  }, [searchFocused]);

  return (
    <div className="search-wrap" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, position: 'relative' }}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        style={{ width: 16, height: 16, color: 'var(--text3)', flexShrink: 0 }}
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        ref={inputRef}
        className="search"
        placeholder="Search files..."
        autoComplete="off"
        value={searchQuery}
        onChange={(e) => setSearch(e.target.value)}
        onFocus={() => setSearchFocused(true)}
        onBlur={() => setSearchFocused(false)}
        style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 13 }}
      />
      <span className="kbd-hint">⌘K</span>
    </div>
  );
}
