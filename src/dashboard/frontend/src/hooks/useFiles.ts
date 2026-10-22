import { useEffect } from 'react';
import { useFileStore } from '@/stores/fileStore';

export function useFiles() {
  const store = useFileStore();

  useEffect(() => {
    store.fetchFiles();
    store.fetchDirectories();
  }, []);

  return store;
}
