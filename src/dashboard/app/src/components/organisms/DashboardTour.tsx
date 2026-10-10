'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface TourStep {
  id: string;
  title: string;
  description: string;
  target: string; // CSS selector for the element to highlight
  position: 'top' | 'bottom' | 'left' | 'right' | 'center';
}

const tourSteps: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Code Context MCP! 🎉',
    description: 'This dashboard helps you manage your project with AI-assisted scrum processes. Let\'s take a quick tour.',
    target: 'body',
    position: 'center',
  },
  {
    id: 'navigation',
    title: 'Navigation Tabs',
    description: 'Use these tabs to navigate between Sprints, Planning, Code Explorer, Team, and Retro views.',
    target: '.top-nav',
    position: 'bottom',
  },
  {
    id: 'sprints',
    title: 'Sprint Overview',
    description: 'View all your sprints here. Track progress, velocity, and ticket status across your entire project.',
    target: '.sprint-cards',
    position: 'left',
  },
  {
    id: 'kanban',
    title: 'Kanban Board',
    description: 'Drag and drop tickets between columns. Visualize workflow from TODO to DONE.',
    target: '.kanban-board',
    position: 'top',
  },
  {
    id: 'team',
    title: 'Your AI Team',
    description: 'Meet your virtual scrum team! Each agent has a role: developers, QA, DevOps, and more.',
    target: '.team-grid',
    position: 'left',
  },
  {
    id: 'ready',
    title: 'You\'re All Set! 🚀',
    description: 'Start your first sprint with /kickoff or explore the dashboard. Check the user guide for more details.',
    target: 'body',
    position: 'center',
  },
];

interface DashboardTourProps {
  onComplete: () => void;
  onDismiss: () => void;
}

export function DashboardTour({ onComplete, onDismiss }: DashboardTourProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [highlightRect, setHighlightRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    // Calculate position of target element
    const step = tourSteps[currentStep];
    if (step.target === 'body') {
      setHighlightRect(null);
      return;
    }

    const targetEl = document.querySelector(step.target);
    if (targetEl) {
      setHighlightRect(targetEl.getBoundingClientRect());
    } else {
      setHighlightRect(null);
    }
  }, [currentStep]);

  const handleNext = () => {
    if (currentStep < tourSteps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      onComplete();
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const step = tourSteps[currentStep];
  const isLastStep = currentStep === tourSteps.length - 1;
  const isFirstStep = currentStep === 0;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 9999,
          pointerEvents: 'none',
        }}
      >
        {/* Backdrop */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            pointerEvents: 'auto',
          }}
          onClick={onDismiss}
        />

        {/* Highlight */}
        {highlightRect && (
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0 }}
            style={{
              position: 'absolute',
              left: highlightRect.left - 8,
              top: highlightRect.top - 8,
              width: highlightRect.width + 16,
              height: highlightRect.height + 16,
              border: '3px solid var(--accent)',
              borderRadius: 12,
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.5)',
              pointerEvents: 'none',
            }}
          />
        )}

        {/* Tour Card */}
        <motion.div
          key={currentStep}
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          transition={{ duration: 0.3 }}
          style={{
            position: 'absolute',
            left: '50%',
            top: highlightRect
              ? highlightRect.bottom + 20
              : '50%',
            transform: 'translateX(-50%)',
            maxWidth: 400,
            minWidth: 300,
            backgroundColor: 'var(--surface1)',
            borderRadius: 16,
            padding: 24,
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)',
            border: '1px solid var(--surface3)',
            pointerEvents: 'auto',
          }}
        >
          {/* Progress Dots */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, justifyContent: 'center' }}>
            {tourSteps.map((_, i) => (
              <div
                key={i}
                style={{
                  width: i === currentStep ? 24 : 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: i === currentStep ? 'var(--accent)' : 'var(--surface3)',
                  transition: 'all 0.3s',
                }}
              />
            ))}
          </div>

          {/* Content */}
          <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 600 }}>
            {step.title}
          </h2>
          <p style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.5, color: 'var(--text2)' }}>
            {step.description}
          </p>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            {!isFirstStep && (
              <button
                onClick={handlePrev}
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: '1px solid var(--surface3)',
                  background: 'transparent',
                  color: 'var(--text1)',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: 500,
                }}
              >
                Back
              </button>
            )}
            <button
              onClick={handleNext}
              style={{
                padding: '8px 20px',
                borderRadius: 'var(--radius-pill)',
                border: 'none',
                background: 'var(--pill-bg)',
                color: 'var(--pill-fg)',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {isLastStep ? 'Get Started' : 'Next'}
            </button>
            <button
              onClick={onDismiss}
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: 'var(--text2)',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              Skip
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
