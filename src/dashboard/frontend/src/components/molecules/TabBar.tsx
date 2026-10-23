import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cx } from '@/lib/utils';

interface Tab {
  id: string;
  label: string;
}

interface TabBarProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
}

export function TabBar({ tabs, activeTab, onTabChange }: TabBarProps) {
  const reduceMotion = useReducedMotion();

  return (
    <div className="tabs relative">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            className={cx(
              'tab relative cursor-pointer border-none bg-transparent pb-2 font-body',
              isActive && 'active',
            )}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
            {isActive && (
              <motion.div
                layoutId="tab-underline"
                className="absolute inset-x-0 bottom-0 h-0.5 rounded-[2px] bg-accent"
                transition={
                  reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 400, damping: 30 }
                }
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
