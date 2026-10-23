import React from 'react';
import { Dot } from '@/components/atoms/Dot';
import { cx, langColors, fmtSize } from '@/lib/utils';
import type { File } from '@/types';

interface FileItemProps {
  file: File;
  isActive: boolean;
  onClick: (id: number) => void;
}

export function FileItem({ file, isActive, onClick }: FileItemProps) {
  const color = langColors[file.language] ?? langColors.unknown;
  const name = file.path.split('/').pop() ?? file.path;

  return (
    <div
      data-testid="file-item"
      className={cx(
        'flex cursor-pointer items-center gap-[6px] overflow-hidden rounded-[6px] px-2 py-1 [transition:background_0.15s] hover:bg-surface-2',
        isActive && 'bg-surface-3 text-accent hover:bg-surface-3',
      )}
      onClick={() => onClick(file.id)}
      title={file.summary || file.path}
    >
      <div className="flex min-w-0 items-center gap-[6px]">
        <Dot color={color} />
        <span className="flex-1 overflow-hidden text-13 text-ellipsis whitespace-nowrap">
          {name}
        </span>
        <span className="ml-auto shrink-0 font-code text-10 text-fg-3">
          {fmtSize(file.size_bytes)}
        </span>
      </div>
      {file.summary && (
        <div className="overflow-hidden pl-5 text-10 leading-[1.3] text-ellipsis whitespace-nowrap text-fg-3">
          {file.summary}
        </div>
      )}
    </div>
  );
}
