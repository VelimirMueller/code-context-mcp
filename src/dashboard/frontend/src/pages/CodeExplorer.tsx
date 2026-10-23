import React, { type CSSProperties } from 'react';
import { useFiles } from '@/hooks/useFiles';
import { useFileStore } from '@/stores/fileStore';
import { useUIStore } from '@/stores/uiStore';
import { FileTree } from '@/components/organisms/FileTree';
import { DependencyGraph } from '@/components/organisms/DependencyGraph';
import { SearchBar } from '@/components/molecules/SearchBar';
import { SubTabBar } from '@/components/molecules/SubTabBar';
import { TabBar } from '@/components/molecules/TabBar';
import { StatGroup } from '@/components/molecules/StatGroup';
import { HeroText } from '@/components/molecules/HeroText';
import { AnimatedNumber } from '@/components/atoms/AnimatedNumber';
import { Badge } from '@/components/atoms/Badge';
import { Skeleton } from '@/components/atoms/Skeleton';
import { ErrorBoundary } from '@/components/atoms/ErrorBoundary';
import { cx, fmtSize, langColors } from '@/lib/utils';

// ─── Tab definitions ──────────────────────────────────────────────────────────
const EXPLORER_TABS = [
  { id: 'detail', label: 'Detail' },
  { id: 'graph', label: 'Graph' },
  { id: 'changes', label: 'Changes' },
];

const CODE_TABS = [
  { key: 'files', label: 'Explorer' },
  { key: 'graph', label: 'Dependencies' },
  { key: 'stats', label: 'Stats' },
];

// ─── Detail tab ───────────────────────────────────────────────────────────────
function DetailTab() {
  const fileDetail = useFileStore((s) => s.fileDetail);
  const selectedFileId = useFileStore((s) => s.selectedFileId);
  const loadingDetail = useFileStore((s) => s.loading.detail);

  if (!selectedFileId && !fileDetail) {
    return (
      <div className="empty py-16 px-10 text-center text-fg-3">
        <div className="empty-icon text-32 mb-4 opacity-30">📄</div>
        <div>Select a file to view details</div>
      </div>
    );
  }

  if (loadingDetail) {
    return (
      <div className="py-4 px-5">
        <Skeleton width="60%" height={18} />
        <Skeleton width="40%" />
        <Skeleton count={3} />
      </div>
    );
  }

  if (!fileDetail) return null;

  const d = fileDetail;
  const exports = Array.isArray(d.exports) ? d.exports : [];
  const imports = Array.isArray(d.imports) ? d.imports : [];
  const importedBy = Array.isArray(d.importedBy) ? d.importedBy : [];

  return (
    <div>
      {/* Title / meta */}
      <div className="detail-section">
        <div className="detail-title">{d.path}</div>
        <div className="detail-meta mt-2">
          <span>{d.language}</span>
          {' · '}
          <span>{d.line_count ?? 0} lines</span>
          {' · '}
          <span className="font-code">{fmtSize(d.size_bytes ?? 0)}</span>
        </div>
        {d.description && <div className="detail-desc">{d.description}</div>}
        {d.summary && d.summary !== d.description && (
          <div className="detail-desc mt-1 italic">{d.summary}</div>
        )}
      </div>

      {/* Exports */}
      {exports.length > 0 && (
        <div className="detail-section">
          <h3>Exports ({exports.length})</h3>
          <div className="flex flex-col gap-1.5 mt-1">
            {exports.map((exp, i) => {
              const e = typeof exp === 'string' ? { name: exp, kind: '', description: null } : exp;
              return (
                <div key={i} className="flex items-baseline gap-1.5">
                  <Badge text={e.name} variant="pkg" />
                  {e.kind && <span className="text-10 text-fg-3 font-code">{e.kind}</span>}
                  {e.description && (
                    <span className="text-11 text-fg-2 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                      {e.description}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Imports */}
      {imports.length > 0 && (
        <div className="detail-section">
          <h3>Imports ({imports.length})</h3>
          {imports.map((imp, i) => {
            const path = typeof imp === 'string' ? imp : (imp?.path ?? '');
            const symbols = typeof imp === 'string' ? imp : (imp?.symbols ?? '');
            const short = path ? path.split('/').slice(-2).join('/') : '(unknown)';
            return (
              <div key={i} className="dep-item">
                <div className="dep-path">{short}</div>
                <div className="dep-symbols">{symbols}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Imported By */}
      {importedBy.length > 0 && (
        <div className="detail-section">
          <h3>Imported By ({importedBy.length})</h3>
          {importedBy.map((dep, i) => {
            const path = typeof dep === 'string' ? dep : (dep?.path ?? '');
            const symbols = typeof dep === 'string' ? dep : (dep?.symbols ?? '');
            const short = path ? path.split('/').slice(-2).join('/') : '(unknown)';
            return (
              <div key={i} className="dep-item">
                <div className="dep-path">{short}</div>
                <div className="dep-symbols">{symbols}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Changes tab ──────────────────────────────────────────────────────────────
function ChangesTab() {
  const fileChanges = useFileStore((s) => s.fileChanges);
  const selectedFileId = useFileStore((s) => s.selectedFileId);
  const loadingChanges = useFileStore((s) => s.loading.changes);

  if (!selectedFileId) {
    return (
      <div className="empty py-16 px-10 text-center text-fg-3">
        <div className="empty-icon text-32 mb-4 opacity-30">🕐</div>
        <div>Select a file to view its change history</div>
      </div>
    );
  }

  if (loadingChanges) {
    return (
      <div className="py-4 px-5">
        <Skeleton count={4} />
      </div>
    );
  }

  if (!fileChanges || !fileChanges.length) {
    return (
      <div className="empty py-12 px-10 text-center text-fg-3">
        <div className="empty-icon text-[28px] mb-3 opacity-30">📋</div>
        <div>No changes recorded</div>
      </div>
    );
  }

  return (
    <div>
      {(fileChanges ?? []).map((change) => {
        if (!change) return null;
        const date = new Date(change.timestamp ?? 0);
        const dateStr = isNaN(date.getTime())
          ? change.timestamp
          : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = isNaN(date.getTime())
          ? ''
          : date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        const lineDiff = (change.new_line_count ?? 0) - (change.old_line_count ?? 0);
        const sizeDiff = (change.new_size_bytes ?? 0) - (change.old_size_bytes ?? 0);

        return (
          <div key={change.id} className="change-item">
            <div className="change-header">
              <span
                className={`change-event ${change.event ?? 'change'} text-10 font-bold uppercase tracking-[0.06em] py-[3px] px-[10px] rounded-[6px] bg-blue-glow text-blue border border-[rgba(59,130,246,.15)]`}
              >
                {change.event ?? 'change'}
              </span>
              <span className="text-12 text-fg-3 font-code">
                {dateStr} {timeStr}
              </span>
              {lineDiff !== 0 && (
                <span className="ml-auto flex gap-2 text-11 font-code">
                  <span className={lineDiff > 0 ? 'text-green' : 'text-red'}>
                    {lineDiff > 0 ? '+' : ''}
                    {lineDiff} lines
                  </span>
                </span>
              )}
            </div>
            {change.new_summary && (
              <div className="mt-2 text-13 text-fg-2 leading-[1.5]">{change.new_summary}</div>
            )}
            {change.reason && <div className="mt-1 text-11 text-fg-3 italic">{change.reason}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export function CodeExplorer() {
  useFiles();

  const stats = useFileStore((s) => s.stats);
  const files = useFileStore((s) => s.files);
  const directories = useFileStore((s) => s.directories);
  const fetchStats = useFileStore((s) => s.fetchStats);

  // Fetch stats once files load
  React.useEffect(() => {
    if (files.length > 0 && !stats) fetchStats();
  }, [files.length, stats, fetchStats]);

  const activeTab = useUIStore((s) => s.activeTab);
  const setTab = useUIStore((s) => s.setTab);

  // Default to 'detail' tab on explorer page
  const explorerTab = ['detail', 'changes', 'graph'].includes(activeTab) ? activeTab : 'detail';

  const codeTab = ['files', 'graph', 'stats'].includes(activeTab) ? activeTab : 'files';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <SubTabBar tabs={CODE_TABS} />
      {/* Topbar with stats + search */}
      <div className="flex items-center gap-5 px-7 border-b border-b-line bg-surface h-16 shrink-0">
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-8 h-8 rounded-[10px] bg-[linear-gradient(135deg,var(--color-accent)_0%,#a5b4fc_100%)] flex items-center justify-center [box-shadow:0_0_20px_rgba(99,102,241,0.2)]">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2"
              width="16"
              height="16"
            >
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <span
            data-testid="logo-text"
            className="font-display text-[15px] font-bold tracking-[-0.01em] uppercase"
          >
            Code Context <span className="text-fg-3 font-normal">Explorer</span>
          </span>
        </div>

        <div className="flex-1 flex items-center bg-surface-2 border border-line rounded-[10px] px-3 h-9 max-w-[360px]">
          <SearchBar />
        </div>

        <div className="ml-auto">
          <StatGroup stats={stats} />
        </div>

        <span
          title="Live"
          className="w-2 h-2 rounded-[50%] bg-accent [box-shadow:0_0_6px_var(--accent)] shrink-0"
        />
      </div>

      {/* Body — switches based on code sub-tab */}
      {codeTab === 'files' && (
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Sidebar */}
          <div className="sidebar w-[300px] shrink-0 flex flex-col border-r border-r-line bg-surface overflow-hidden">
            <div className="sidebar-head flex items-center gap-2 py-3 px-4 border-b border-b-line shrink-0">
              <span className="font-semibold text-13 text-fg">Files</span>
              <span className="count text-10 text-fg-3 bg-surface-3 py-0.5 px-[7px] rounded-[6px] font-code font-medium">
                {files.length}
              </span>
            </div>
            <div className="sidebar-body flex-1 overflow-y-auto py-[10px] px-3 min-h-0">
              <ErrorBoundary>
                <FileTree />
              </ErrorBoundary>
            </div>
          </div>

          {/* Main panel */}
          <div className="main flex-1 flex flex-col overflow-hidden bg-bg min-w-0">
            <TabBar tabs={EXPLORER_TABS} activeTab={explorerTab} onTabChange={setTab} />

            <HeroText>
              {'Tracking '}
              <AnimatedNumber value={files.length} />
              {' files across '}
              <AnimatedNumber value={directories.length} />
              {' directories — '}
              <AnimatedNumber value={stats?.exports ?? 0} />
              {' exports indexed'}
            </HeroText>

            <div
              className={cx(
                'flex-1 min-h-0 flex flex-col',
                explorerTab === 'graph' ? 'overflow-y-hidden' : 'overflow-y-auto',
              )}
            >
              <ErrorBoundary key={explorerTab}>
                {explorerTab === 'detail' && <DetailTab />}
                {explorerTab === 'changes' && <ChangesTab />}
                {explorerTab === 'graph' && <DependencyGraph />}
              </ErrorBoundary>
            </div>
          </div>
        </div>
      )}

      {codeTab === 'graph' && (
        <div className="flex-1 overflow-hidden">
          <HeroText>
            {'Dependency graph — '}
            <AnimatedNumber value={files.length} />
            {' files, '}
            <AnimatedNumber value={stats?.deps ?? 0} />
            {' connections'}
          </HeroText>
          <div className="flex-1 h-[calc(100%-40px)]">
            <DependencyGraph />
          </div>
        </div>
      )}

      {codeTab === 'stats' && (
        <div className="flex-1 overflow-y-auto p-5">
          <HeroText>
            {'Codebase stats — '}
            <AnimatedNumber value={files.length} />
            {' files indexed'}
          </HeroText>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 py-0 px-5">
            {[
              { label: 'Files', value: files.length },
              { label: 'Directories', value: directories.length },
              { label: 'Exports', value: stats?.exports ?? 0 },
              { label: 'Dependencies', value: stats?.deps ?? 0 },
            ].map((s) => (
              <div
                key={s.label}
                className="p-4 bg-surface border border-line rounded-[8px] text-center"
              >
                <div className="text-10 font-semibold text-fg-3 uppercase mb-1.5">{s.label}</div>
                <div className="text-[24px] font-bold font-code text-fg">{s.value}</div>
              </div>
            ))}
          </div>
          {stats?.extensions && Array.isArray(stats.extensions) && stats.extensions.length > 0 && (
            <div className="pt-5 px-5 pb-0">
              <div className="text-13 font-bold text-fg mb-3">File Types</div>
              <div className="flex flex-col gap-1.5">
                {(stats.extensions as { extension: string; c: number }[]).map((ext) => {
                  const pct = files.length > 0 ? (ext.c / files.length) * 100 : 0;
                  const color = langColors[ext.extension] || 'var(--accent)';
                  return (
                    <div key={ext.extension} className="flex items-center gap-[10px]">
                      <div className="w-[60px] text-12 font-code text-fg-2 font-semibold">
                        {ext.extension}
                      </div>
                      <div className="flex-1 h-2 bg-line rounded-[4px] overflow-hidden">
                        <div
                          style={{ width: `${pct}%`, '--c': color } as CSSProperties}
                          className="h-full bg-(--c) rounded-[4px]"
                        />
                      </div>
                      <div className="w-10 text-11 font-code text-fg-3 text-right">{ext.c}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
