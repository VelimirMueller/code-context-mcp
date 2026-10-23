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
    <div className="relative flex flex-1 items-center gap-2">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="h-4 w-4 shrink-0 text-fg-3"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        ref={inputRef}
        className="flex-1 border-none bg-transparent text-13 text-fg outline-none"
        placeholder="Search files..."
        autoComplete="off"
        value={searchQuery}
        onChange={(e) => setSearch(e.target.value)}
        onFocus={() => setSearchFocused(true)}
        onBlur={() => setSearchFocused(false)}
      />
      <span>⌘K</span>
    </div>
  );
}
