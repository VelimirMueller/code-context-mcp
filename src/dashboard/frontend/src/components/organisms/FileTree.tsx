import React, { useMemo } from 'react';
import { useFileStore } from '@/stores/fileStore';
import { useUIStore } from '@/stores/uiStore';
import { useSearch } from '@/hooks/useSearch';
import { FolderItem } from '@/components/molecules/FolderItem';
import { FileItem } from '@/components/molecules/FileItem';
import { Skeleton } from '@/components/atoms/Skeleton';
import type { File, Directory } from '@/types';

export function FileTree() {
  const files = useFileStore((s) => s.files);
  const directories = useFileStore((s) => s.directories);
  const selectedFileId = useFileStore((s) => s.selectedFileId);
  const loadingFiles = useFileStore((s) => s.loading.files);
  const selectFile = useFileStore((s) => s.selectFile);

  const expandedFolders = useUIStore((s) => s.expandedFolders);
  const toggleFolder = useUIStore((s) => s.toggleFolder);
  const expandFolderPath = useUIStore((s) => s.expandFolderPath);

  const { filteredFiles, debouncedQuery } = useSearch();

  const { rootDir, dirChildren, dirInfoMap, filesByDir } = useMemo(() => {
    if (!directories.length && !files.length) {
      return { rootDir: '', dirChildren: new Map<string, string[]>(), dirInfoMap: new Map<string, Directory>(), filesByDir: new Map<string, File[]>() };
    }

    const rootDir = directories.length
      ? directories.reduce((a, b) => (a.path.length <= b.path.length ? a : b)).path
      : '';

    const filesByDir = new Map<string, File[]>();
    files.forEach((f) => {
      const dir = f.path.substring(0, f.path.lastIndexOf('/'));
      if (!filesByDir.has(dir)) filesByDir.set(dir, []);
      filesByDir.get(dir)!.push(f);
    });

    const dirChildren = new Map<string, string[]>();
    const dirInfoMap = new Map<string, Directory>();
    directories.forEach((d) => {
      dirInfoMap.set(d.path, d);
      const parent = d.parent_path;
      if (parent && parent.length >= rootDir.length) {
        if (!dirChildren.has(parent)) dirChildren.set(parent, []);
        dirChildren.get(parent)!.push(d.path);
      }
    });

    return { rootDir, dirChildren, dirInfoMap, filesByDir };
  }, [files, directories]);

  const handleSelectFile = (id: number) => {
    const file = files.find((f) => f.id === id);
    if (file) expandFolderPath(file.path);
    selectFile(id);
  };

  if (loadingFiles && !files.length) {
    return (
      <div style={{ padding: '10px 12px' }}>
        <Skeleton count={6} width="80%" />
        <Skeleton count={4} width="65%" />
      </div>
    );
  }

  if (!files.length) {
    return (
      <div className="empty">
        <div className="empty-icon">📂</div>
        <div>No files indexed</div>
      </div>
    );
  }

  // Search mode: flat filtered list
  if (debouncedQuery) {
    return (
      <div>
        {filteredFiles.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">🔍</div>
            <div>No files match "{debouncedQuery}"</div>
          </div>
        ) : (
          filteredFiles.map((file) => (
            <FileItem
              key={file.id}
              file={file}
              isActive={file.id === selectedFileId}
              onClick={handleSelectFile}
            />
          ))
        )}
      </div>
    );
  }

  // Tree mode
  const rootChildDirs = (dirChildren.get(rootDir) ?? []).slice().sort();
  const rootFiles = (filesByDir.get(rootDir) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));

  return (
    <div>
      {rootChildDirs.map((childPath) => {
        const info = dirInfoMap.get(childPath);
        if (!info) return null;
        return (
          <FolderItem
            key={childPath}
            dirPath={childPath}
            dirInfo={info}
            dirChildren={dirChildren}
            dirInfoMap={dirInfoMap}
            filesByDir={filesByDir}
            expandedFolders={expandedFolders}
            selectedFileId={selectedFileId}
            onToggle={toggleFolder}
            onSelectFile={handleSelectFile}
          />
        );
      })}
      {rootFiles.map((file) => (
        <FileItem
          key={file.id}
          file={file}
          isActive={file.id === selectedFileId}
          onClick={handleSelectFile}
        />
      ))}
    </div>
  );
}
