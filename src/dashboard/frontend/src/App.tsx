'use client';

import React, { Suspense, lazy, useState, useEffect } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useUIStore, type PageType } from '@/stores/uiStore';
import { useFileStore } from '@/stores/fileStore';
import { useSprintStore } from '@/stores/sprintStore';
import { useAgentStore } from '@/stores/agentStore';
import { usePlanningStore } from '@/stores/planningStore';
import { useBridgeStore } from '@/stores/bridgeStore';
import { useComparisonStore } from '@/stores/comparisonStore';
import { useEventSource, type SSEConnectionState } from '@/hooks/useEventSource';
import { useHashRouter } from '@/hooks/useHashRouter';
import { useKeyboard } from '@/hooks/useKeyboard';

const CodeExplorer = lazy(() =>
  import('@/pages/CodeExplorer').then((m) => ({ default: m.CodeExplorer })),
);
const Dashboard = lazy(() => import('@/pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Team = lazy(() => import('@/pages/Team').then((m) => ({ default: m.Team })));
const Retro = lazy(() => import('@/pages/Retro').then((m) => ({ default: m.Retro })));
const ProjectManagement = lazy(() =>
  import('@/pages/ProjectManagement').then((m) => ({ default: m.ProjectManagement })),
);
const Benchmark = lazy(() => import('@/pages/Benchmark').then((m) => ({ default: m.Benchmark })));
import { pageVariants, pageTransition, reducedMotion } from '@/lib/motion';
import { cx } from '@/lib/utils';
import { ToastContainer } from '@/components/atoms/ToastContainer';
import { BridgeStatusBadge } from '@/components/atoms/BridgeStatusBadge';
import { ErrorBoundary } from '@/components/atoms/ErrorBoundary';
import { LandingAnimation } from '@/components/organisms/LandingAnimation';
import { DashboardTour } from '@/components/organisms/DashboardTour';
import { TopNav } from '@/components/molecules/TopNav';
import { QuickActionsBar } from '@/components/molecules/QuickActionsBar';
import { Breadcrumb } from '@/components/molecules/Breadcrumb';
import { WizardModal } from '@/components/molecules/WizardModal';

// Legacy page name mapping (old -> new PageType)
const pageMapping: Record<string, PageType> = {
  explorer: 'code',
  sprint: 'dashboard',
};

// Legacy URL redirect map: old hash -> new hash
const legacyUrlMap: Record<string, string> = {
  '#sprint': '#dashboard',
  '#sprint/board': '#dashboard/board',
  '#sprint/team': '#team',
  '#sprint/insights': '#retro',
  '#explorer': '#code',
  '#explorer/files': '#code/files',
};

// SSE indicator: text colour + opacity of the label, colour of the dot.
const sseTone: Record<SSEConnectionState, string> = {
  connected: 'text-green opacity-60',
  reconnecting: 'text-orange opacity-100',
  disconnected: 'text-red opacity-100',
};
const sseDot: Record<SSEConnectionState, string> = {
  connected: 'bg-green',
  reconnecting: 'bg-orange animate-[pulse_1.5s_ease-in-out_infinite]',
  disconnected: 'bg-red',
};

const skeletonBar = 'bg-surface-2 animate-[pulse_1.5s_ease-in-out_infinite]';

function PageSkeleton() {
  return (
    <div className="p-5 h-full">
      <div className="flex gap-3 mb-5">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className={`w-20 h-8 rounded-[6px] ${skeletonBar}`} />
        ))}
      </div>
      <div className="grid grid-cols-[240px_1fr] gap-4 h-[calc(100%-60px)]">
        <div className="flex flex-col gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className={`h-14 rounded-[8px] ${skeletonBar}`} />
          ))}
        </div>
        <div className="flex flex-col gap-3">
          <div className={`h-6 w-[40%] rounded-[6px] ${skeletonBar}`} />
          <div className={`h-4 w-[70%] rounded-[6px] ${skeletonBar}`} />
          <div className={`flex-1 rounded-[8px] ${skeletonBar}`} />
        </div>
      </div>
    </div>
  );
}

export function App() {
  const activePage = useUIStore((s) => s.activePage);
  const setPage = useUIStore((s) => s.setPage);
  const prefersReducedMotion = useReducedMotion();

  // Map legacy page names to new PageType
  const normalizedPage: PageType =
    pageMapping[activePage as keyof typeof pageMapping] || (activePage as PageType);

  const quickActions: {
    id: string;
    label: string;
    icon: React.ReactNode;
    count: number;
    onClick: () => void;
  }[] = [];

  const breadcrumb = useUIStore((s) => s.breadcrumbTrail);

  // Legacy URL redirect handling
  useEffect(() => {
    const hash = window.location.hash;
    const cleanHash = hash.split('?')[0]; // Remove query params for redirect lookup

    // Check if the current hash matches any legacy URLs
    if (cleanHash && legacyUrlMap[cleanHash]) {
      window.location.hash = legacyUrlMap[cleanHash];
    }
  }, []);

  // Show landing animation once per session
  const [showLanding, setShowLanding] = useState(
    () => sessionStorage.getItem('landing-played') !== 'true',
  );

  // Show tour once per session (after landing completes)
  const [showTour, setShowTour] = useState(() => localStorage.getItem('tour-completed') !== 'true');

  // SSE: refresh stores on server events
  const refreshFiles = useFileStore((s) => s.refresh);
  const fetchSprints = useSprintStore((s) => s.fetchSprints);
  const fetchAgents = useAgentStore((s) => s.fetchAgents);
  const selectedSprintId = useSprintStore((s) => s.selectedSprintId);
  const fetchTickets = useSprintStore((s) => s.fetchTickets);
  const fetchRetro = useSprintStore((s) => s.fetchRetro);
  const fetchAllRetro = useSprintStore((s) => s.fetchAllRetro);
  const fetchActivities = useSprintStore((s) => s.fetchActivities);
  const fetchBurndown = useSprintStore((s) => s.fetchBurndown);
  const fetchBlockers = useSprintStore((s) => s.fetchBlockers);
  const fetchBugs = useSprintStore((s) => s.fetchBugs);
  const fetchMilestones = usePlanningStore((s) => s.fetchMilestones);
  const fetchComparison = useComparisonStore((s) => s.fetchComparison);
  const fetchBridgeStatus = useBridgeStore((s) => s.fetchStatus);
  const fetchBridgeActions = useBridgeStore((s) => s.fetchActions);
  const handleInputRequested = useBridgeStore((s) => s.handleInputRequested);
  const handleStepProgress = useBridgeStore((s) => s.handleStepProgress);
  const handleClaudeOutput = useBridgeStore((s) => s.handleClaudeOutput);
  const handleClaudeStep = useBridgeStore((s) => s.handleClaudeStep);
  const wizardSteps = useBridgeStore((s) => s.wizardSteps);
  const wizardOpen = useBridgeStore((s) => s.wizardOpen);
  const dismissWizard = useBridgeStore((s) => s.dismissWizard);
  const completeWizard = useBridgeStore((s) => s.completeWizard);

  const { connectionState } = useEventSource({
    onEvent: (event) => {
      // Refresh all data stores on any server event
      refreshFiles();
      fetchSprints();
      fetchAgents();
      fetchMilestones();
      fetchBridgeStatus();
      fetchBridgeActions();
      fetchAllRetro();
      fetchActivities();
      fetchComparison();
      // Re-fetch sprint-specific data for the currently selected sprint
      if (selectedSprintId) {
        fetchTickets(selectedSprintId);
        fetchRetro(selectedSprintId);
        fetchBurndown(selectedSprintId);
        fetchBlockers(selectedSprintId);
        fetchBugs(selectedSprintId);
      }
      // Auto-open wizard modal on input_requested events
      if (event.type === 'input_requested' && event.entityId) {
        fetchBridgeActions('pending').then(() => {
          const actions = useBridgeStore.getState().actions;
          const action = actions.find(
            (a) => a.id === Number(event.entityId) && a.action === 'request_input',
          );
          if (action) handleInputRequested(action);
        });
      }
      // Handle step progress updates
      if (event.type === 'step_progress' && event.stepProgress) {
        handleStepProgress(event.stepProgress);
      }
      // Handle Claude output streaming
      if (event.type === 'claude_output' && event.claudeOutput) {
        handleClaudeOutput(event.claudeOutput);
      }
      // Handle Claude step transitions
      if (event.type === 'claude_step' && event.claudeStep) {
        handleClaudeStep(event.claudeStep);
      }
    },
  });

  // URL hash sync
  useHashRouter();

  // Keyboard shortcuts
  useKeyboard();

  const variants = prefersReducedMotion ? reducedMotion : pageVariants;

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {showLanding && <LandingAnimation onComplete={() => setShowLanding(false)} />}
      {showTour && !showLanding && (
        <DashboardTour
          onComplete={() => {
            setShowTour(false);
            localStorage.setItem('tour-completed', 'true');
          }}
          onDismiss={() => {
            setShowTour(false);
            localStorage.setItem('tour-completed', 'true');
          }}
        />
      )}
      <header className="flex items-center gap-5 px-7 border-b border-b-line bg-surface h-16 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-[10px] bg-[linear-gradient(135deg,var(--color-accent)_0%,#a5b4fc_100%)] flex items-center justify-center [box-shadow:0_0_20px_rgba(99,102,241,0.2)]">
            <svg viewBox="0 0 24 24" fill="white" width="16" height="16">
              <path
                d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
                stroke="white"
                strokeWidth="2"
                fill="none"
              />
            </svg>
          </div>
          <span
            data-testid="logo-text"
            className="font-display text-[15px] font-bold tracking-[-0.01em] uppercase"
          >
            Code Context <span className="text-fg-3 font-normal">MCP</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            title={`SSE: ${connectionState}`}
            className={cx('inline-flex items-center gap-1 text-11', sseTone[connectionState])}
          >
            <span className={cx('w-[6px] h-[6px] rounded-[50%]', sseDot[connectionState])} />
            {connectionState !== 'connected' && connectionState}
          </span>
          <BridgeStatusBadge />
        </div>
      </header>

      {/* Top Navigation */}
      <TopNav
        activeTab={normalizedPage}
        onTabChange={(tab) => {
          setPage(tab);
        }}
      />

      {/* Quick Actions Bar */}
      <QuickActionsBar
        actions={quickActions}
        searchQuery={useUIStore((s) => s.searchQuery)}
        onSearchChange={useUIStore((s) => s.setSearch)}
        breadcrumbItems={breadcrumb}
      />
      <main data-testid="page-content" className="flex-1 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={normalizedPage}
            variants={variants}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={prefersReducedMotion ? { duration: 0 } : pageTransition}
            className="h-full"
          >
            <Suspense fallback={<PageSkeleton />}>
              {normalizedPage === 'dashboard' && (
                <ErrorBoundary>
                  <Dashboard />
                </ErrorBoundary>
              )}
              {normalizedPage === 'planning' && (
                <ErrorBoundary>
                  <ProjectManagement />
                </ErrorBoundary>
              )}
              {normalizedPage === 'code' && (
                <ErrorBoundary>
                  <CodeExplorer />
                </ErrorBoundary>
              )}
              {normalizedPage === 'team' && (
                <ErrorBoundary>
                  <Team />
                </ErrorBoundary>
              )}
              {normalizedPage === 'retro' && (
                <ErrorBoundary>
                  <Retro />
                </ErrorBoundary>
              )}
              {normalizedPage === 'benchmark' && (
                <ErrorBoundary>
                  <Benchmark />
                </ErrorBoundary>
              )}
            </Suspense>
          </motion.div>
        </AnimatePresence>
      </main>
      {wizardOpen && wizardSteps.length > 0 && (
        <WizardModal steps={wizardSteps} onComplete={completeWizard} onDismiss={dismissWizard} />
      )}
      <ToastContainer />
    </div>
  );
}
