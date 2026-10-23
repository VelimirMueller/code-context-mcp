import { useUIStore } from '@/stores/uiStore';
import { cx } from '@/lib/utils';

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
      className="flex shrink-0 gap-0 border-b border-b-line bg-surface px-5"
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
            className={cx(
              'cursor-pointer bg-transparent px-5 py-3 font-body text-13 transition-all [border-style:none_none_solid] [border-width:0_0_2px]',
              isActive
                ? 'border-b-accent font-semibold text-accent'
                : 'border-b-transparent font-medium text-fg-3',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
