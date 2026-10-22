import { useUIStore } from '@/stores/uiStore';

interface Tab {
  key: string;
  label: string;
}

interface SubTabBarProps {
  tabs: Tab[];
  active?: string;
  onChange?: (key: string) => void;
}

/**
 * Reusable sub-tab navigation bar.
 * If no active/onChange props are provided, it auto-syncs with the hash router via uiStore.
 * This makes it a drop-in for any page — just pass tabs and it works.
 */
export function SubTabBar({ tabs, active, onChange }: SubTabBarProps) {
  const storeTab = useUIStore((s) => s.activeTab);
  const setTab = useUIStore((s) => s.setTab);

  const currentTab = active ?? storeTab;
  const handleChange = onChange ?? setTab;

  return (
    <div
      role="tablist"
      aria-label="Sub navigation"
      style={{
        display: 'flex',
        gap: 0,
        borderBottom: '1px solid var(--border)',
        padding: '0 20px',
        background: 'var(--surface)',
        flexShrink: 0,
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.key === currentTab;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={isActive}
            onClick={() => handleChange(tab.key)}
            onKeyDown={(e) => {
              const idx = tabs.findIndex((t) => t.key === tab.key);
              if (e.key === 'ArrowRight' && idx < tabs.length - 1) {
                handleChange(tabs[idx + 1].key);
                (e.currentTarget.nextElementSibling as HTMLElement)?.focus();
              } else if (e.key === 'ArrowLeft' && idx > 0) {
                handleChange(tabs[idx - 1].key);
                (e.currentTarget.previousElementSibling as HTMLElement)?.focus();
              }
            }}
            tabIndex={isActive ? 0 : -1}
            style={{
              padding: '12px 20px',
              fontSize: 13,
              fontWeight: isActive ? 600 : 500,
              color: isActive ? 'var(--accent)' : 'var(--text3)',
              cursor: 'pointer',
              border: 'none',
              background: 'none',
              borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              fontFamily: 'var(--font)',
              transition: 'all .2s',
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
