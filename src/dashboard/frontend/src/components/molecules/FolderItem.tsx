import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { FileItem } from './FileItem';
import { cx } from '@/lib/utils';
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
  const childFiles = (filesByDir.get(dirPath) ?? [])
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path));

  return (
    <div className="tree-folder" data-folder-path={dirPath}>
      <div
        className="flex cursor-pointer items-center gap-[6px] rounded-[6px] px-2 py-1 [transition:background_0.15s] hover:bg-surface-2"
        onClick={() => onToggle(dirPath)}
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={cx(
            'size-3.5 shrink-0 [transition:transform_.2s]',
            isOpen ? 'text-accent [transform:rotate(90deg)]' : 'text-fg-3',
          )}
        >
          <path d="M6 3l5 5-5 5z" />
        </svg>
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          className={cx('shrink-0 text-14', isOpen ? 'text-accent' : 'text-fg-3')}
        >
          <path
            d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5V4.5z"
            stroke="currentColor"
            strokeWidth="1.3"
            fill={isOpen ? 'currentColor' : 'none'}
            fillOpacity={isOpen ? 0.15 : 0}
          />
        </svg>
        <span className="flex-1 overflow-hidden text-13 font-medium text-ellipsis whitespace-nowrap">
          {dirInfo.name}
        </span>
        <span className="ml-auto shrink-0 font-code text-10 text-fg-3">{dirInfo.file_count}</span>
      </div>
      {dirInfo.description && !isOpen && (
        <div
          className="overflow-hidden pt-0 pr-3 pb-1 pl-[42px] text-10 leading-[1.3] text-ellipsis whitespace-nowrap text-fg-3"
          title={dirInfo.description}
        >
          {dirInfo.description}
        </div>
      )}

      <motion.div
        className="ml-3 overflow-hidden"
        initial={false}
        animate={{ height: isOpen ? 'auto' : 0, opacity: isOpen ? 1 : 0 }}
        transition={
          reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 25 }
        }
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
