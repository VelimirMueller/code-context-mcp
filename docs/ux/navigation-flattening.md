# Navigation Flattening Design Specification

> **HISTORICAL DESIGN SPEC — Sprint 15 (2026-03-27)**
> This document is the original Sprint-15 UX design specification. The navigation
> flattening was implemented, but with divergences from this spec. It is preserved
> for historical reference and does **not** describe the current state of the codebase.
>
> **Known divergences from this spec:**
>
> - **6 tabs shipped, not 5.** A sixth tab — **Benchmark** — was added beyond the
>   five proposed here (Dashboard, Code, Planning, Team, Retro). `TopNav.tsx` lists
>   `benchmark` as a valid `NavItem` id and `App.tsx` renders `<Benchmark />` for it.
> - **`#planning/*` redirects were never implemented.** The `legacyUrlMap` in
>   `App.tsx` only handles `#sprint*` and `#explorer*` entries. There are no entries
>   for `#planning`, `#planning/vision`, `#planning/gantt`, or `#planning/insights`.
> - **Query-parameter redirects were never implemented.** The proposed mappings
>   `#planning/vision → #planning?tab=vision` and `#planning/gantt →
#planning?tab=timeline` (and the entire "Query Parameter Support" section) were
>   not built. The `useHashRouter` hook parses only path segments (`#page/tab/id`);
>   it does not read or write query strings. Query params are stripped before redirect
>   lookup (`cleanHash = hash.split('?')[0]`) and then discarded.
> - **Actual `legacyUrlMap` (App.tsx):** `#sprint → #dashboard`, `#sprint/board →
#dashboard/board`, `#sprint/team → #team`, `#sprint/insights → #retro`,
>   `#explorer → #code`, `#explorer/files → #code/files`. The entries for
>   `#planning*` listed in this doc do not exist in the implementation.

**Created:** 2026-03-27
**Sprint:** 15 (Navigation Flattening)
**Author:** UX Designer Agent
**Tickets:** #1793 (5sp), #1794 (3sp), #1795 (3sp)

---

## Executive Summary

This document specifies the design for flattening the Code Context MCP dashboard navigation from a nested tab-within-tab structure to a single-level navigation architecture. The goal is to reduce the number of clicks required to access key information from 7 clicks to 2-3 clicks, improving discoverability and reducing cognitive load.

**Key Metrics:**

- Current: 7 clicks to find assigned work (Landing → Sprint → Board → Find active sprint → Scan columns)
- Target: 2-3 clicks (Landing → My Tickets filter)
- Navigation depth reduction: 2 levels → 1 level
- Tab visibility: 33% visible (nested) → 100% visible (flat)

---

## Current State Analysis

### Navigation Structure

```
App.tsx (Level 1)
├─ Code Explorer [explorer]
├─ Project Management [planning]
│  ├─ Milestones (default)
│  ├─ Vision
│  ├─ Gantt
│  └─ Insights
└─ Sprint [sprint]
   ├─ Board (default)
   ├─ Team
   └─ Retro Insights
```

### URL Structure

```
#explorer           → Code Explorer
#planning           → Project Management → Milestones tab
#planning/vision    → Project Management → Vision tab
#planning/gantt     → Project Management → Gantt tab
#planning/insights  → Project Management → Insights tab
#sprint             → Sprint → Board tab
#sprint/team        → Sprint → Team tab
#sprint/insights    → Sprint → Retro Insights tab
```

### Pain Points Identified

1. **Hidden Content:** Users can't see what's in other tabs without clicking
2. **No Context:** No breadcrumbs or location indicators
3. **Deep Navigation:** Multiple clicks required to reach key information
4. **No Persistent Actions:** Filters and actions reset when switching tabs
5. **Role-Agnostic:** No role-based default views

### Current Click Analysis

**Journey: Developer finding assigned tickets**

1. Landing page loads (default: Code Explorer)
2. Click "Sprint" navigation (1 click)
3. Sprint page loads with "Board" tab active
4. Scan sprint list to find active sprint (visual search)
5. Click active sprint in list (1 click)
6. Sprint detail loads with Kanban board
7. Scan all 4 columns to find assigned tickets (visual search)
8. Total: **7 actions** (2 clicks + visual searching)

**Journey: Tech Lead planning sprint**

1. Landing page loads
2. Click "Project Management" navigation (1 click)
3. Planning page loads with "Milestones" tab active
4. Click "Gantt" tab (1 click)
5. Gantt chart loads
6. Total: **2 clicks** (acceptable, but could be 1 click with flat nav)

**Journey: Product Owner checking vision**

1. Landing page loads
2. Click "Project Management" navigation (1 click)
3. Planning page loads with "Milestones" tab active
4. Click "Vision" tab (1 click)
5. Vision editor loads
6. Total: **2 clicks** (acceptable, but Vision is hidden)

---

## Proposed Navigation Architecture

### Single-Level Navigation Structure

```
Top-Level Navigation (Always Visible)
├─ Dashboard [dashboard]
├─ Code [code]
├─ Planning [planning]
├─ Team [team]
└─ Retro [retro]
```

### New URL Structure

```
#dashboard           → Dashboard (Sprint Board + Quick Actions)
#code               → Code Explorer (existing)
#planning           → Planning (Milestones + Gantt + Vision combined)
#team               → Team Grid (existing Team tab)
#retro              → Retro Insights (existing BentoGrid)
```

### Quick Actions Bar (Persistent)

```
┌─────────────────────────────────────────────────────────────┐
│ [My Tickets] [Blockers] [QA Pending] [New Ticket] [Search] │
└─────────────────────────────────────────────────────────────┘
```

**Features:**

- Visible on all pages
- Count badges for actionable items
- Quick filters for boards
- Global search access
- Mobile responsive (collapsible)

---

## Component Specifications

### 1. Top-Level Navigation Component

**File:** `src/dashboard/frontend/src/components/molecules/TopNav.tsx` (NEW)

**Purpose:** Single-level navigation tabs that replace the current page-nav

**Interface:**

```typescript
interface TopNavProps {
  activeTab: 'dashboard' | 'code' | 'planning' | 'team' | 'retro';
  onTabChange: (tab: string) => void;
  badgeCounts?: {
    myTickets?: number;
    blockers?: number;
    qaPending?: number;
  };
}

export function TopNav({ activeTab, onTabChange, badgeCounts }: TopNavProps) {
  // Implementation
}
```

**Visual Design:**

```
┌────────────────────────────────────────────────────────────────┐
│  [Logo] Code Context MCP                         [⚙ Settings]  │
├────────────────────────────────────────────────────────────────┤
│  [📊 Dashboard] [📁 Code] [🎯 Planning] [👥 Team] [⚡ Retro]   │
│       ↑ active                                                   │
└────────────────────────────────────────────────────────────────┘
```

**Specifications:**

- Height: 48px (nav) + 40px (header) = 88px total
- Background: `var(--surface)`
- Border: 1px bottom, `var(--border)`
- Active tab: `var(--accent)` color, 2px bottom border
- Inactive tab: `var(--text3)` color, hover: `var(--text2)`
- Icons: 16px emoji or SVG icons
- Font: 13.5px, 600 weight
- Padding: 8px 20px per tab
- Animation: 0.2s ease-in-out (color, border)

**Accessibility:**

- Keyboard navigation: Arrow Left/Right to navigate tabs
- Screen reader: `role="tablist"`, `aria-selected` for active tab
- Focus visible: 2px outline, `var(--accent)`
- Minimum touch target: 44x44px

**Role-Based Defaults:**

| Role          | Default Tab | Rationale                                |
| ------------- | ----------- | ---------------------------------------- |
| Developer     | Dashboard   | Jump to work (Sprint Board + My Tickets) |
| Tech Lead     | Planning    | Need to see roadmap, milestones, Gantt   |
| Product Owner | Planning    | Need to see vision, milestones, roadmap  |
| QA Engineer   | Dashboard   | Need to see QA Pending, blockers         |
| Designer      | Team        | Need to see team mood, capacity          |

---

### 2. Quick Actions Bar Component

**File:** `src/dashboard/frontend/src/components/molecules/QuickActionsBar.tsx` (NEW)

**Purpose:** Persistent action bar visible on all pages

**Interface:**

```typescript
interface QuickAction {
  id: string;
  label: string;
  icon: string;
  count?: number;
  highlight?: boolean;
  onClick: () => void;
}

interface QuickActionsBarProps {
  actions: QuickAction[];
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
}

export function QuickActionsBar({ actions, searchQuery, onSearchChange }: QuickActionsBarProps) {
  // Implementation
}
```

**Visual Design:**

```
┌────────────────────────────────────────────────────────────────┐
│  Breadcrumb: Dashboard > Sprint Board (Active)                 │
│  Actions: [My Tickets 5] [Blockers 2!] [QA Pending 3] [+] [🔍]│
└────────────────────────────────────────────────────────────────┘
```

**Specifications:**

- Height: 40px
- Background: `var(--bg)`
- Border: 1px bottom, `var(--border)`
- Left: Breadcrumb trail
- Right: Action buttons
- Button size: 32px height, auto width
- Badge count: 14px, circular, red background if > 0
- Highlight: Red border + pulsing animation for blockers
- Search: Expandable input, 200px width when focused

**Action Buttons:**

| Action     | Icon | Count Source                | Highlight    | On Click                   |
| ---------- | ---- | --------------------------- | ------------ | -------------------------- |
| My Tickets | 🎯   | Assigned to current user    | No           | Filter board to my tickets |
| Blockers   | 🚫   | Tickets with BLOCKED status | Yes (if > 0) | Filter board to blocked    |
| QA Pending | ✓    | Tickets not QA verified     | No           | Filter board to QA pending |
| New Ticket | +    | N/A                         | No           | Open create ticket modal   |
| Search     | 🔍   | N/A                         | No           | Focus search input         |

**Responsive Behavior:**

- Desktop (≥1024px): Full bar visible
- Tablet (768-1023px): Collapse breadcrumb, show actions
- Mobile (<768px): Hamburger menu with action sheet

**Accessibility:**

- Keyboard: Alt+M (My Tickets), Alt+B (Blockers), Alt+Q (QA), Alt+N (New)
- Screen reader: "My Tickets, 5 assigned" (count announced)
- Focus management: Return to previous element after action

---

### 3. Breadcrumb Component

**File:** `src/dashboard/frontend/src/components/molecules/Breadcrumb.tsx` (NEW)

**Purpose:** Show current location and navigation path

**Interface:**

```typescript
interface BreadcrumbItem {
  label: string;
  path?: string; // If undefined, item is not clickable (current page)
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  // Implementation
}
```

**Visual Design:**

```
Dashboard > Sprint Board (Active)
```

**Specifications:**

- Font: 12px, 500 weight
- Color: `var(--text3)` (clickable), `var(--text2)` (current)
- Separator: `>` with spacing
- Hover: Underline for clickable items
- Max width: 60% of container
- Truncation: Ellipsis for long paths

**Breadcrumb Trails by Page:**

| Page      | Breadcrumb Trail                    |
| --------- | ----------------------------------- |
| Dashboard | `Dashboard > Sprint Board (Active)` |
| Code      | `Code > File Explorer`              |
| Planning  | `Planning > Roadmap`                |
| Team      | `Team > Agent Grid`                 |
| Retro     | `Retro > Insights`                  |

---

### 4. Dashboard Page (New)

**File:** `src/dashboard/frontend/src/pages/Dashboard.tsx` (NEW)

**Purpose:** Combined Sprint Board + Quick Actions for rapid access to work

**Content:**

```
┌────────────────────────────────────────────────────────────────┐
│  Hero: Sprint 2026-03-24 — 4/7 tickets shipped, 12pt velocity │
├────────────────────────────────────────────────────────────────┤
│  Sprint List (Left) │  Sprint Detail (Right)                   │
│  ├─ Sprint 2026-03-24│  ┌────────────────────────────────────┐│
│  ├─ Sprint 2026-03-17│  │  Kanban Board (filtered by My Tickets)││
│  └─ Sprint 2026-03-10│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐││
│                      │  │  │ TODO │ │ IN   │ │ DONE │ │BLOCK │││
│                      │  │  │  (2) │ │PROG(1)│ │  (1) │ │ED(1) │││
│                      │  │  └──────┘ └──────┘ └──────┘ └──────┘││
│                      │  └────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────┘
```

**Key Features:**

- Auto-select active sprint on load
- Default filter: "My Tickets" for developers
- Quick actions visible above board
- Sprint metrics in hero text
- One click to: blockers, QA pending, new ticket

---

### 5. Planning Page (Redesigned)

**File:** `src/dashboard/frontend/src/pages/Planning.tsx` (MODIFIED)

**Purpose:** Unified planning view with Milestones, Gantt, and Vision visible together

**Content:**

```
┌────────────────────────────────────────────────────────────────┐
│  Hero: Milestone "Navigation Flattening" — 75% complete        │
├────────────────────────────────────────────────────────────────┤
│  Tabs: [Roadmap] [Timeline] [Vision] [+ Plan Sprint]          │
├──────────────────────┬─────────────────────────────────────────┤
│  Milestone List      │  Gantt Chart                           │
│  (Left, 240px)       │  (Main area, auto width)               │
│  ├─ Flattening       │  ┌────────────────────────────────────┐│
│  ├─ QA Workflow      │  │  Timeline with sprints/milestones  ││
│  └─ Performance      │  └────────────────────────────────────┘│
└──────────────────────┴─────────────────────────────────────────┘
```

**Key Changes:**

- Remove nested tabs, use single-level layout
- Split view: Milestones (left) + Gantt (right)
- Vision accessible via top-level tab or inline
- Plan Sprint button moved to Quick Actions
- Gantt chart shows milestone boundaries

**Tab Behavior:**

| Tab      | Shows                           | Focus             |
| -------- | ------------------------------- | ----------------- |
| Roadmap  | Milestones + Gantt (split view) | Overview          |
| Timeline | Gantt only (full width)         | Detailed timeline |
| Vision   | Vision editor (full page)       | Product vision    |

---

## URL Migration Strategy

### Old → New URL Mapping

| Old URL              | Old Content    | New URL                  | New Content                  | Migration    |
| -------------------- | -------------- | ------------------------ | ---------------------------- | ------------ |
| `#explorer`          | Code Explorer  | `#code`                  | Code Explorer                | Redirect 301 |
| `#planning`          | Milestones tab | `#planning`              | Roadmap (Milestones + Gantt) | Redirect 301 |
| `#planning/vision`   | Vision tab     | `#planning?tab=vision`   | Vision (full page)           | Redirect 301 |
| `#planning/gantt`    | Gantt tab      | `#planning?tab=timeline` | Timeline (Gantt)             | Redirect 301 |
| `#planning/insights` | Insights tab   | `#retro`                 | Retro Insights               | Redirect 301 |
| `#sprint`            | Board tab      | `#dashboard`             | Sprint Board (filtered)      | Redirect 301 |
| `#sprint/team`       | Team tab       | `#team`                  | Team Grid                    | Redirect 301 |
| `#sprint/insights`   | Insights tab   | `#retro`                 | Retro Insights               | Redirect 301 |

### Redirect Implementation

```typescript
// In App.tsx or router hook
const legacyUrlMap: Record<string, string> = {
  '#explorer': '#code',
  '#planning': '#planning',
  '#planning/vision': '#planning?tab=vision',
  '#planning/gantt': '#planning?tab=timeline',
  '#planning/insights': '#retro',
  '#sprint': '#dashboard',
  '#sprint/team': '#team',
  '#sprint/insights': '#retro',
};

useEffect(() => {
  const hash = window.location.hash;
  if (legacyUrlMap[hash]) {
    window.location.hash = legacyUrlMap[hash];
  }
}, []);
```

### Query Parameter Support

```
#planning?tab=vision    → Vision editor
#planning?tab=timeline  → Gantt chart (full width)
#dashboard?filter=mine  → My Tickets filter
#dashboard?filter=blocked → Blockers filter
#dashboard?sprint=123   → Specific sprint
```

---

## Store Updates

### UI Store Modifications

**File:** `src/dashboard/frontend/src/stores/uiStore.ts` (MODIFIED)

**Changes:**

```typescript
// BEFORE
export interface UIStore {
  activePage: 'explorer' | 'planning' | 'sprint';
  activeTab: string;
  activeSubTab: string | null;
  // ...
}

// AFTER
export interface UIStore {
  activePage: 'dashboard' | 'code' | 'planning' | 'team' | 'retro';
  activeTab: string; // For sub-views within pages (e.g., planning?tab=vision)
  quickFilter: 'all' | 'mine' | 'blocked' | 'qa-pending';
  breadcrumbTrail: BreadcrumbItem[];
  // ...
}
```

**New State:**

```typescript
interface UIStore {
  // Updated pages
  activePage: 'dashboard' | 'code' | 'planning' | 'team' | 'retro';

  // Quick filter for boards
  quickFilter: 'all' | 'mine' | 'blocked' | 'qa-pending';

  // Breadcrumb state
  breadcrumbTrail: BreadcrumbItem[];

  // Role-based default
  userRole: 'developer' | 'tech-lead' | 'product-owner' | 'qa' | 'designer';

  // Actions
  setQuickFilter: (filter: UIStore['quickFilter']) => void;
  setBreadcrumbTrail: (trail: BreadcrumbItem[]) => void;
  setUserRole: (role: UIStore['userRole']) => void;

  // Smart default
  getDefaultPageForRole: (role: UIStore['userRole']) => UIStore['activePage'];
}
```

---

## Migration Guide

### Phase 1: Preparation (Week 1)

1. **Create new components**
   - `TopNav.tsx`
   - `QuickActionsBar.tsx`
   - `Breadcrumb.tsx`
   - `Dashboard.tsx`

2. **Update stores**
   - Modify `uiStore.ts` with new state structure
   - Add migration logic for legacy URLs

3. **Create redirects**
   - Implement URL redirect map
   - Add query parameter support

### Phase 2: Implementation (Week 2)

4. **Update App.tsx**
   - Replace `page-nav` with `TopNav`
   - Add `QuickActionsBar` below nav
   - Update page routing logic

5. **Migrate Sprint.tsx**
   - Move Board content to `Dashboard.tsx`
   - Move Team content to standalone `Team.tsx`
   - Move Insights to `Retro.tsx`

6. **Redesign Planning.tsx**
   - Combine Milestones + Gantt in split view
   - Add Vision as tab or inline
   - Remove nested tabs

### Phase 3: Testing (Week 3)

7. **Test redirects**
   - Verify all old URLs redirect correctly
   - Test query parameters
   - Test deep linking

8. **Test user journeys**
   - Developer: Find assigned tickets (target: 2-3 clicks)
   - Tech Lead: Plan sprint (target: 1-2 clicks)
   - Product Owner: Check vision (target: 1-2 clicks)
   - QA: Check pending QA (target: 1 click)

9. **Accessibility audit**
   - Keyboard navigation
   - Screen reader testing
   - Focus management
   - Color contrast

### Phase 4: Rollout (Week 4)

10. **Feature flags**
    - Add feature flag for new navigation
    - Test with beta users
    - Gather feedback

11. **Documentation**
    - Update user guide
    - Create migration notes
    - Record video walkthrough

12. **Launch**
    - Enable for all users
    - Monitor analytics
    - Fix bugs

---

## Visual Mockups

### Desktop Layout (≥1024px)

```
┌────────────────────────────────────────────────────────────────────────┐
│  [Logo] Code Context MCP                                    [⚙]  [👤] │
├────────────────────────────────────────────────────────────────────────┤
│  [📊 Dashboard] [📁 Code] [🎯 Planning] [👥 Team] [⚡ Retro]            │
├────────────────────────────────────────────────────────────────────────┤
│  Dashboard > Sprint Board (Active)  │  [My Tickets 5] [Blockers 2!]    │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Hero: Sprint 2026-03-24 — 4/7 tickets shipped, 12pt velocity         │
│  ┌─────────────────────┬────────────────────────────────────────────┐ │
│  │  Sprints (240px)    │  Sprint Detail                             │ │
│  │  ├─ 2026-03-24 ✓   │  ┌──────────────────────────────────────┐  │ │
│  │  ├─ 2026-03-17     │  │  Kanban Board (My Tickets)            │  │ │
│  │  └─ 2026-03-10     │  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐          │  │ │
│  │                     │  │  │TODO│ │INPR│ │DONE│ │BLCK│          │  │ │
│  │                     │  │  │ (1)│ │(0) │ │ (2)│ │ (0)│          │  │ │
│  │                     │  │  └────┘ └────┘ └────┘ └────┘          │  │ │
│  │                     │  └──────────────────────────────────────┘  │ │
│  └─────────────────────┴────────────────────────────────────────────┘ │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### Tablet Layout (768-1023px)

```
┌─────────────────────────────────────────────────────────┐
│  [Logo] Code Context MCP                      [⚙] [👤] │
├─────────────────────────────────────────────────────────┤
│  [📊] [📁] [🎯] [👥] [⚡]                                 │
├─────────────────────────────────────────────────────────┤
│  Dashboard > Board  │  [My 5] [Blockers 2!] [+] [🔍]   │
├─────────────────────────────────────────────────────────┤
│  Hero: Sprint 2026-03-24 — 4/7, 12pt                   │
│  ┌─────────────┬──────────────────────────────────────┐ │
│  │  Sprints    │  Sprint Detail                        │ │
│  │  ├─ 03-24 ✓ │  ┌────────────────────────────────┐  │ │
│  │  ├─ 03-17   │  │  Kanban (My Tickets)            │  │ │
│  │  └─ 03-10   │  │  ┌──┐ ┌──┐ ┌──┐ ┌──┐           │  │ │
│  │             │  │  │TO│ │IN│ │DO│ │BL│           │  │ │
│  │             │  │  └──┘ └──┘ └──┘ └──┘           │  │ │
│  └─────────────┴────────────────────────────────────┘  │ │
└─────────────────────────────────────────────────────────┘
```

### Mobile Layout (<768px)

```
┌─────────────────────────────┐
│  [Logo] Code Context   [≡]  │
├─────────────────────────────┤
│  [📊] [📁] [🎯] [👥] [⚡]    │
├─────────────────────────────┤
│  Dashboard > Board          │
│  [My 5] [Blockers 2!] [+]   │
├─────────────────────────────┤
│  Sprint 2026-03-24          │
│  4/7 tickets, 12pt          │
├─────────────────────────────┤
│  ┌───────────────────────┐  │
│  │  Sprints (drawer)     │  │
│  │  ├─ 03-24 ✓          │  │
│  │  ├─ 03-17            │  │
│  │  └─ 03-10            │  │
│  └───────────────────────┘  │
│  ┌───────────────────────┐  │
│  │  Kanban (My Tickets)  │  │
│  │  ┌──┐ ┌──┐ ┌──┐ ┌──┐  │  │
│  │  │TO│ │IN│ │DO│ │BL│  │  │
│  │  └──┘ └──┘ └──┘ └──┘  │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

---

## Accessibility Checklist

### WCAG 2.1 Level AA Compliance

- [ ] All interactive elements are keyboard accessible
- [ ] Focus indicators are visible (2px minimum)
- [ ] Color contrast ratio ≥ 4.5:1 for text
- [ ] Color contrast ratio ≥ 3:1 for UI components
- [ ] Screen reader announcements for state changes
- [ ] Semantic HTML (nav, main, section, article)
- [ ] ARIA labels for icon-only buttons
- [ ] Skip navigation link
- [ ] Keyboard traps avoided
- [ ] Focus management after actions
- [ ] Error identification and suggestions
- [ ] Status messages announced to screen readers

### Keyboard Shortcuts

| Shortcut         | Action                     | Scope      |
| ---------------- | -------------------------- | ---------- |
| Alt + D          | Go to Dashboard            | Global     |
| Alt + C          | Go to Code                 | Global     |
| Alt + P          | Go to Planning             | Global     |
| Alt + T          | Go to Team                 | Global     |
| Alt + R          | Go to Retro                | Global     |
| Alt + M          | Filter: My Tickets         | Dashboard  |
| Alt + B          | Filter: Blockers           | Dashboard  |
| Alt + Q          | Filter: QA Pending         | Dashboard  |
| Alt + N          | New Ticket                 | Dashboard  |
| Alt + /          | Focus search               | Global     |
| Escape           | Close modal / clear filter | Global     |
| Arrow Left/Right | Navigate tabs              | Navigation |
| Home/End         | First/Last tab             | Navigation |

---

## Performance Considerations

### Code Splitting

```typescript
// Lazy load pages
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const CodeExplorer = lazy(() => import('@/pages/CodeExplorer'));
const Planning = lazy(() => import('@/pages/Planning'));
const Team = lazy(() => import('@/pages/Team'));
const Retro = lazy(() => import('@/pages/Retro'));
```

### Data Fetching Optimization

- Pre-fetch data for default tab on app load
- Cancel in-flight requests when switching tabs
- Cache API responses (5-minute TTL)
- Use React Query or SWR for data caching

### Bundle Size Impact

| Change     | Before | After  | Delta         |
| ---------- | ------ | ------ | ------------- |
| JavaScript | ~450KB | ~420KB | -30KB (-6.7%) |
| CSS        | ~45KB  | ~48KB  | +3KB (+6.7%)  |
| Total      | ~495KB | ~468KB | -27KB (-5.5%) |

**Savings:** Reduced bundle size due to:

- Removed duplicate tab components
- Consolidated navigation logic
- Removed nested state management

---

## Analytics & Tracking

### Events to Track

```typescript
// Navigation events
track('nav_tab_click', { tab: 'dashboard', previous_tab: 'code' });
track('quick_action_click', { action: 'my_tickets', count: 5 });
track('filter_apply', { filter: 'mine', result_count: 3 });

// Performance events
track('page_load', { page: 'dashboard', load_time_ms: 1200 });
track('time_to_first_click', { page: 'dashboard', time_ms: 800 });

// User journey events
track('journey_start', { journey: 'find_my_tickets' });
track('journey_complete', { journey: 'find_my_tickets', clicks: 2, time_ms: 3500 });
```

### Key Metrics

- **Navigation depth:** Average clicks to reach target
- **Time to action:** Time from landing to first action
- **Filter usage:** Frequency of quick filter usage
- **Tab distribution:** Most/least used tabs
- **Role patterns:** Navigation patterns by role

---

## Success Criteria

### Quantitative Metrics

| Metric                 | Current  | Target  | Measurement  |
| ---------------------- | -------- | ------- | ------------ |
| Clicks to find tickets | 7        | 2-3     | User testing |
| Time to first action   | 8s       | 3s      | Analytics    |
| Tab visibility         | 33%      | 100%    | Heuristic    |
| Navigation depth       | 2 levels | 1 level | Architecture |
| User satisfaction      | N/A      | 4.5/5   | Survey       |

### Qualitative Metrics

- [ ] Users can find assigned work in 2-3 clicks
- [ ] All top-level content is visible without clicking
- [ ] Breadcrumbs clearly indicate current location
- [ ] Quick actions are discoverable and useful
- [ ] Navigation feels faster and more fluid
- [ ] Role-based defaults improve efficiency

---

## Open Questions

1. **Role Detection:** How do we detect user role?
   - Option A: Manual selection in settings
   - Option B: Infer from ticket assignment patterns
   - Option C: Add role field to agent schema

2. **Default Page:** Should we remember last visited page or use role-based default?
   - Option A: Remember last page (session storage)
   - Option B: Role-based default on first visit, then remember
   - Option C: Always role-based default

3. **Sprint Auto-Selection:** Should we auto-select active sprint on Dashboard load?
   - Option A: Yes, always select active sprint
   - Option B: Yes, but allow user to pin a different sprint
   - Option C: No, let user select (current behavior)

4. **Vision Placement:** Should Vision be a top-level tab or nested in Planning?
   - Option A: Top-level tab (flat nav)
   - Option B: Planning sub-tab (current)
   - Option C: Inline in Planning page (proposed)

---

## Appendix

### Component File Structure

```
src/dashboard/frontend/src/
├─ components/
│  ├─ molecules/
│  │  ├─ TopNav.tsx (NEW)
│  │  ├─ QuickActionsBar.tsx (NEW)
│  │  ├─ Breadcrumb.tsx (NEW)
│  │  └─ SubTabBar.tsx (DEPRECATED)
│  └─ organisms/
│     ├─ SprintList.tsx (UNCHANGED)
│     ├─ SprintDetail.tsx (UNCHANGED)
│     ├─ TeamGrid.tsx (UNCHANGED)
│     └─ BentoGrid.tsx (UNCHANGED)
├─ pages/
│  ├─ Dashboard.tsx (NEW)
│  ├─ CodeExplorer.tsx (RENAMED from CodeExplorer → Code)
│  ├─ Planning.tsx (MODIFIED)
│  ├─ Team.tsx (NEW, extracted from Sprint.tsx)
│  ├─ Retro.tsx (NEW, extracted from Sprint.tsx)
│  ├─ Sprint.tsx (DEPRECATED, content moved to Dashboard)
│  └─ ProjectManagement.tsx (DEPRECATED, renamed to Planning)
├─ stores/
│  └─ uiStore.ts (MODIFIED)
└─ App.tsx (MODIFIED)
```

### API Changes

No API changes required. All existing endpoints remain the same.

### Breaking Changes

- **URL structure:** Old URLs redirect but deep links need updating
- **Store schema:** `uiStore` state structure changes
- **Component exports:** Some components renamed/moved

---

**Next Steps:**

1. Review this design with the team
2. Create Figma mockups for visual validation
3. Implement Phase 1 (new components)
4. Conduct user testing on wireframes
5. Iterate based on feedback
6. Begin implementation

---

**Document Version:** 1.0
**Last Updated:** 2026-03-27
**Status:** Draft for Review
