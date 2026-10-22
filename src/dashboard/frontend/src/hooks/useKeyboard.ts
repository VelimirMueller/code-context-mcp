import { useEffect } from 'react';
import { useUIStore } from '@/stores/uiStore';

export function useKeyboard() {
  const setSearchFocused = useUIStore((s) => s.setSearchFocused);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Cmd+K or Ctrl+K -> focus search
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchFocused(true);
      }

      // Escape -> blur search
      if (e.key === 'Escape') {
        setSearchFocused(false);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setSearchFocused]);
}
