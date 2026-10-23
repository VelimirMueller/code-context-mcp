'use client';

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cx } from '@/lib/utils';

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
    description:
      "This dashboard helps you manage your project with AI-assisted scrum processes. Let's take a quick tour.",
    target: 'body',
    position: 'center',
  },
  {
    id: 'navigation',
    title: 'Navigation Tabs',
    description:
      'Use these tabs to navigate between Sprints, Planning, Code Explorer, Team, and Retro views.',
    target: '[data-tour="top-nav"]',
    position: 'bottom',
  },
  {
    id: 'sprints',
    title: 'Sprint Overview',
    description:
      'View all your sprints here. Track progress, velocity, and ticket status across your entire project.',
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
    description:
      'Meet your virtual scrum team! Each agent has a role: developers, QA, DevOps, and more.',
    target: '.team-grid',
    position: 'left',
  },
  {
    id: 'ready',
    title: "You're All Set! 🚀",
    description:
      'Start your first sprint with /kickoff or explore the dashboard. Check the user guide for more details.',
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
        className="fixed inset-0 z-[9999] pointer-events-none"
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-[rgba(0,0,0,0.5)] pointer-events-auto"
          onClick={onDismiss}
        />

        {/* Highlight */}
        {highlightRect && (
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0 }}
            className="absolute border-[3px] border-accent rounded-[12px] [box-shadow:0_0_0_9999px_rgba(0,0,0,0.5)] pointer-events-none"
            style={{
              left: highlightRect.left - 8,
              top: highlightRect.top - 8,
              width: highlightRect.width + 16,
              height: highlightRect.height + 16,
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
          className="absolute left-1/2 max-w-[400px] min-w-[300px] bg-(--surface1) rounded-[16px] p-6 [box-shadow:0_20px_60px_rgba(0,0,0,0.3)] border border-surface-3 pointer-events-auto"
          style={{ top: highlightRect ? highlightRect.bottom + 20 : '50%' }}
        >
          {/* Progress Dots */}
          <div className="flex gap-[6px] mb-4 justify-center">
            {tourSteps.map((_, i) => (
              <div
                key={i}
                className={cx(
                  'h-2 rounded-[4px] [transition:all_0.3s]',
                  i === currentStep ? 'w-6 bg-accent' : 'w-2 bg-surface-3',
                )}
              />
            ))}
          </div>

          {/* Content */}
          <h2 className="mb-3 text-[20px] font-semibold">{step.title}</h2>
          <p className="mb-5 text-14 leading-[1.5] text-fg-2">{step.description}</p>

          {/* Actions */}
          <div className="flex gap-3 justify-end">
            {!isFirstStep && (
              <button
                onClick={handlePrev}
                className="py-2 px-4 rounded-[8px] border border-surface-3 bg-transparent text-(color:--text1) cursor-pointer text-14 font-medium"
              >
                Back
              </button>
            )}
            <button
              onClick={handleNext}
              className="py-2 px-5 rounded-pill border-none bg-pill text-pill-fg cursor-pointer text-14 font-semibold"
            >
              {isLastStep ? 'Get Started' : 'Next'}
            </button>
            <button
              onClick={onDismiss}
              className="py-2 px-3 rounded-[8px] border-none bg-transparent text-fg-2 cursor-pointer text-12"
            >
              Skip
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
