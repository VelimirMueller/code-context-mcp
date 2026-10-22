import React from 'react';
import { Dot } from '@/components/atoms/Dot';
import { langColors, fmtSize } from '@/lib/utils';
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
      className={`file-item${isActive ? ' active' : ''}`}
      onClick={() => onClick(file.id)}
      title={file.summary || file.path}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <Dot color={color} />
        <span className="file-name">{name}</span>
        <span className="file-size">{fmtSize(file.size_bytes)}</span>
      </div>
      {file.summary && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--text3)',
            paddingLeft: 20,
            lineHeight: 1.3,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {file.summary}
        </div>
      )}
    </div>
  );
}
