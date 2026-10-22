import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { FileItem } from './FileItem';
import type { File, Directory } from '@/types';

interface FolderItemProps {
  dirPath: string;
  dirInfo: Directory;
  dirChildren: Map<string, string[]>;
  dirInfoMap: Map<string, Directory>;
  filesByDir: Map<string, File[]>;
  expandedFolders: Set<string>;
  selectedFileId: number | null;
  onToggle: (path: string) => void;
  onSelectFile: (id: number) => void;
  depth?: number;
}

export function FolderItem({
  dirPath,
  dirInfo,
  dirChildren,
  dirInfoMap,
  filesByDir,
  expandedFolders,
  selectedFileId,
  onToggle,
  onSelectFile,
  depth = 0,
}: FolderItemProps) {
  const isOpen = expandedFolders.has(dirPath);
  const reduceMotion = useReducedMotion();
  const childDirPaths = (dirChildren.get(dirPath) ?? []).slice().sort();
  const childFiles = (filesByDir.get(dirPath) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));

  return (
    <div className="tree-folder" data-folder-path={dirPath}>
      <div
        className="tree-folder-head"
        onClick={() => onToggle(dirPath)}
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`chevron${isOpen ? ' open' : ''}`}
          style={{ width: 14, height: 14, flexShrink: 0, transition: 'transform .2s', color: isOpen ? 'var(--accent)' : 'var(--text3)', transform: isOpen ? 'rotate(90deg)' : undefined }}
        >
          <path d="M6 3l5 5-5 5z" />
        </svg>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="folder-icon" style={{ flexShrink: 0, color: isOpen ? 'var(--accent)' : 'var(--text3)' }}>
          <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5V4.5z" stroke="currentColor" strokeWidth="1.3" fill={isOpen ? 'currentColor' : 'none'} fillOpacity={isOpen ? 0.15 : 0} />
        </svg>
        <span className="folder-name">{dirInfo.name}</span>
        <span className="folder-count">{dirInfo.file_count}</span>
      </div>
      {dirInfo.description && !isOpen && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--text3)',
            padding: '0 12px 4px 42px',
            lineHeight: 1.3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={dirInfo.description}
        >
          {dirInfo.description}
        </div>
      )}

      <motion.div
        className="tree-children"
        initial={false}
        animate={{ height: isOpen ? 'auto' : 0, opacity: isOpen ? 1 : 0 }}
        transition={
          reduceMotion
            ? { duration: 0 }
            : { type: 'spring', stiffness: 300, damping: 25 }
        }
        style={{ overflow: 'hidden' }}
      >
        {childDirPaths.map((childPath) => {
          const childInfo = dirInfoMap.get(childPath);
          if (!childInfo) return null;
          return (
            <FolderItem
              key={childPath}
              dirPath={childPath}
              dirInfo={childInfo}
              dirChildren={dirChildren}
              dirInfoMap={dirInfoMap}
              filesByDir={filesByDir}
              expandedFolders={expandedFolders}
              selectedFileId={selectedFileId}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
              depth={depth + 1}
            />
          );
        })}
        {childFiles.map((file) => (
          <FileItem
            key={file.id}
            file={file}
            isActive={file.id === selectedFileId}
            onClick={onSelectFile}
          />
        ))}
      </motion.div>
    </div>
  );
}
