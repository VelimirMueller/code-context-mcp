import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

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
    <div className="tabs" style={{ position: 'relative' }}>
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            className={`tab${isActive ? ' active' : ''}`}
            onClick={() => onTabChange(tab.id)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: 'none',
              cursor: 'pointer',
              fontFamily: 'var(--font)',
              position: 'relative',
              paddingBottom: 8,
            }}
          >
            {tab.label}
            {isActive && (
              <motion.div
                layoutId="tab-underline"
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  height: 2,
                  background: 'var(--accent)',
                  borderRadius: 2,
                }}
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { type: 'spring', stiffness: 400, damping: 30 }
                }
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
