import React, { useState } from 'react';
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
import { fmtSize, langColors } from '@/lib/utils';

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
      <div className="empty" style={{ padding: '64px 40px', textAlign: 'center', color: 'var(--text3)' }}>
        <div className="empty-icon" style={{ fontSize: 32, marginBottom: 16, opacity: 0.3 }}>📄</div>
        <div>Select a file to view details</div>
      </div>
    );
  }

  if (loadingDetail) {
    return (
      <div style={{ padding: '16px 20px' }}>
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
        <div className="detail-meta" style={{ marginTop: 8 }}>
          <span>{d.language}</span>
          {' · '}
          <span>{d.line_count ?? 0} lines</span>
          {' · '}
          <span style={{ fontFamily: 'var(--mono)' }}>{fmtSize(d.size_bytes ?? 0)}</span>
        </div>
        {d.description && (
          <div className="detail-desc">{d.description}</div>
        )}
        {d.summary && d.summary !== d.description && (
          <div className="detail-desc" style={{ marginTop: 4, fontStyle: 'italic' }}>{d.summary}</div>
        )}
      </div>

      {/* Exports */}
      {exports.length > 0 && (
        <div className="detail-section">
          <h3>Exports ({exports.length})</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            {exports.map((exp, i) => {
              const e = typeof exp === 'string' ? { name: exp, kind: '', description: null } : exp;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <Badge text={e.name} variant="pkg" />
                  {e.kind && (
                    <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>{e.kind}</span>
                  )}
                  {e.description && (
                    <span style={{ fontSize: 11, color: 'var(--text2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
      <div className="empty" style={{ padding: '64px 40px', textAlign: 'center', color: 'var(--text3)' }}>
        <div className="empty-icon" style={{ fontSize: 32, marginBottom: 16, opacity: 0.3 }}>🕐</div>
        <div>Select a file to view its change history</div>
      </div>
    );
  }

  if (loadingChanges) {
    return (
      <div style={{ padding: '16px 20px' }}>
        <Skeleton count={4} />
      </div>
    );
  }

  if (!fileChanges || !fileChanges.length) {
    return (
      <div className="empty" style={{ padding: '48px 40px', textAlign: 'center', color: 'var(--text3)' }}>
        <div className="empty-icon" style={{ fontSize: 28, marginBottom: 12, opacity: 0.3 }}>📋</div>
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
                className={`change-event ${change.event ?? 'change'}`}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  padding: '3px 10px',
                  borderRadius: 6,
                  background: 'var(--blue-glow)',
                  color: '#60a5fa',
                  border: '1px solid rgba(59,130,246,.15)',
                }}
              >
                {change.event ?? 'change'}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                {dateStr} {timeStr}
              </span>
              {lineDiff !== 0 && (
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, fontSize: 11, fontFamily: 'var(--mono)' }}>
                  <span style={{ color: lineDiff > 0 ? 'var(--green)' : 'var(--red)' }}>
                    {lineDiff > 0 ? '+' : ''}{lineDiff} lines
                  </span>
                </span>
              )}
            </div>
            {change.new_summary && (
              <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text2)', lineHeight: 1.5 }}>
                {change.new_summary}
              </div>
            )}
            {change.reason && (
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>
                {change.reason}
              </div>
            )}
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <SubTabBar tabs={CODE_TABS} />
      {/* Topbar with stats + search */}
      <div
        className="topbar"
        style={{ display: 'flex', alignItems: 'center', gap: 20, flexShrink: 0 }}
      >
        <div className="logo" style={{ flexShrink: 0 }}>
          <div className="logo-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" width="16" height="16">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="logo-text">
            Code Context <span className="logo-sub">Explorer</span>
          </span>
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            background: 'var(--surface2)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '0 12px',
            height: 36,
            maxWidth: 360,
          }}
        >
          <SearchBar />
        </div>

        <div style={{ marginLeft: 'auto' }}>
          <StatGroup stats={stats} />
        </div>

        <span
          title="Live"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--accent)',
            boxShadow: '0 0 6px var(--accent)',
            flexShrink: 0,
          }}
        />
      </div>

      {/* Body — switches based on code sub-tab */}
      {codeTab === 'files' && (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
          {/* Sidebar */}
          <div
            className="sidebar"
            style={{
              width: 300,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              borderRight: '1px solid var(--border)',
              background: 'var(--surface)',
              overflow: 'hidden',
            }}
          >
            <div className="sidebar-head" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>Files</span>
              <span
                className="count"
                style={{
                  fontSize: 10,
                  color: 'var(--text3)',
                  background: 'var(--surface3)',
                  padding: '2px 7px',
                  borderRadius: 6,
                  fontFamily: 'var(--mono)',
                  fontWeight: 500,
                }}
              >
                {files.length}
              </span>
            </div>
            <div className="sidebar-body" style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', minHeight: 0 }}>
              <ErrorBoundary>
                <FileTree />
              </ErrorBoundary>
            </div>
          </div>

          {/* Main panel */}
          <div
            className="main"
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              background: 'var(--bg)',
              minWidth: 0,
            }}
          >
            <TabBar
              tabs={EXPLORER_TABS}
              activeTab={explorerTab}
              onTabChange={setTab}
            />

            <HeroText>
              {'Tracking '}
              <AnimatedNumber value={files.length} />
              {' files across '}
              <AnimatedNumber value={directories.length} />
              {' directories — '}
              <AnimatedNumber value={stats?.exports ?? 0} />
              {' exports indexed'}
            </HeroText>

            <div style={{ flex: 1, overflowY: explorerTab === 'graph' ? 'hidden' : 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
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
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <HeroText>
            {'Dependency graph — '}
            <AnimatedNumber value={files.length} />
            {' files, '}
            <AnimatedNumber value={stats?.deps ?? 0} />
            {' connections'}
          </HeroText>
          <div style={{ flex: 1, height: 'calc(100% - 40px)' }}>
            <DependencyGraph />
          </div>
        </div>
      )}

      {codeTab === 'stats' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          <HeroText>
            {'Codebase stats — '}
            <AnimatedNumber value={files.length} />
            {' files indexed'}
          </HeroText>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, padding: '0 20px' }}>
            {[
              { label: 'Files', value: files.length },
              { label: 'Directories', value: directories.length },
              { label: 'Exports', value: stats?.exports ?? 0 },
              { label: 'Dependencies', value: stats?.deps ?? 0 },
            ].map((s) => (
              <div key={s.label} style={{ padding: 16, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, textAlign: 'center' }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', marginBottom: 6 }}>{s.label}</div>
                <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'var(--mono)', color: 'var(--text)' }}>{s.value}</div>
              </div>
            ))}
          </div>
          {stats?.extensions && Array.isArray(stats.extensions) && stats.extensions.length > 0 && (
            <div style={{ padding: '20px 20px 0' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 12 }}>File Types</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(stats.extensions as { extension: string; c: number }[]).map((ext) => {
                  const pct = files.length > 0 ? (ext.c / files.length) * 100 : 0;
                  const color = langColors[ext.extension] || 'var(--accent)';
                  return (
                    <div key={ext.extension} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 60, fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text2)', fontWeight: 600 }}>{ext.extension}</div>
                      <div style={{ flex: 1, height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 4 }} />
                      </div>
                      <div style={{ width: 40, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text3)', textAlign: 'right' }}>{ext.c}</div>
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
