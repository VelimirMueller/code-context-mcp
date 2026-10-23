# Navigation Flattening — Design Summary

> **Historical spec — Sprint 15 design document.** This document describes the navigation design as specified in Sprint 15. The feature was subsequently implemented, but shipped with divergences from this spec:
>
> - **Tab count mismatch:** This spec shows 5 top-level tabs (Dashboard, Code, Planning, Team, Retro). The shipped `TopNav.tsx` registers **6 tabs** — a sixth "Benchmark" tab was added after this document was written and is not reflected here.
> - **Quick Actions Bar not wired:** This spec describes a Quick Actions Bar with persistent buttons (My Tickets, Blockers, QA Pending, New Ticket) and count badges. In the shipped `App.tsx`, `quickActions` is initialised as an **empty array** — none of those buttons are connected. The `QuickActionsBar` component renders but receives no actions.
>
> Do not use this document as a reference for current behaviour. See `src/dashboard/frontend/src/components/molecules/TopNav.tsx` and `src/dashboard/frontend/src/App.tsx` for the authoritative current state.

**Created:** 2026-03-27
**Sprint:** 15 (Navigation Flattening)
**Author:** UX Designer Agent
**Status:** Design Complete, Ready for Implementation

---

## What Was Delivered

### 1. Comprehensive Design Specification

**File:** [`navigation-flattening.md`](./navigation-flattening.md)

**Contents:**

- Current state analysis with click depth metrics
- Proposed single-level navigation architecture
- Component specifications (TopNav, QuickActionsBar, Breadcrumb)
- URL migration strategy with redirect map
- Store schema updates
- Visual design specifications (colors, typography, spacing)
- Responsive layouts (desktop, tablet, mobile)
- Accessibility checklist (WCAG 2.1 AA)
- Performance considerations
- Analytics tracking plan
- Success criteria

### 2. Visual Wireframes

**File:** [`navigation-wireframes.md`](./navigation-wireframes.md)

**Contents:**

- 8 detailed wireframes showing all states
- Desktop, tablet, and mobile layouts
- Navigation state transitions
- Role-based view examples
- Color system specification
- Typography scale
- Spacing system

### 3. Implementation Migration Guide (removed)

Removed in #231: its code samples imported dashboard modules that no longer exist. See [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) for the current structure.

---

## Key Design Decisions

### Navigation Structure

**Before (Nested):**

```
App.tsx
├─ Code Explorer
├─ Project Management
│  ├─ Milestones (default)
│  ├─ Vision
│  ├─ Gantt
│  └─ Insights
└─ Sprint
   ├─ Board (default)
   ├─ Team
   └─ Retro Insights
```

**After (Flat):**

```
TopNav (Always Visible)
├─ Dashboard (Sprint Board + Quick Actions)
├─ Code (Code Explorer)
├─ Planning (Milestones + Gantt + Vision)
├─ Team (Agent Grid)
└─ Retro (Retro Insights)
```

### Quick Actions Bar

**Persistent Actions:**

- My Tickets (with count badge)
- Blockers (with highlight if > 0)
- QA Pending (with count badge)
- New Ticket
- Search

**Benefits:**

- Visible on all pages
- Reduces clicks from 7 to 2-3
- Count badges show actionable items
- One-click filters for boards

### URL Migration

| Old URL              | New URL                  | Redirect |
| -------------------- | ------------------------ | -------- |
| `#explorer`          | `#code`                  | 301      |
| `#planning`          | `#planning`              | 301      |
| `#planning/vision`   | `#planning?tab=vision`   | 301      |
| `#planning/gantt`    | `#planning?tab=timeline` | 301      |
| `#planning/insights` | `#retro`                 | 301      |
| `#sprint`            | `#dashboard`             | 301      |
| `#sprint/team`       | `#team`                  | 301      |
| `#sprint/insights`   | `#retro`                 | 301      |

### Role-Based Defaults

| Role          | Default Tab | Rationale        |
| ------------- | ----------- | ---------------- |
| Developer     | Dashboard   | Jump to work     |
| Tech Lead     | Planning    | See roadmap      |
| Product Owner | Planning    | Check vision     |
| QA            | Dashboard   | QA pending items |
| Designer      | Team        | View team mood   |

---

## Metrics & Success Criteria

### Quantitative Targets

| Metric                 | Current  | Target  | Improvement      |
| ---------------------- | -------- | ------- | ---------------- |
| Clicks to find tickets | 7        | 2-3     | 57-71% reduction |
| Time to first action   | 8s       | 3s      | 62.5% reduction  |
| Tab visibility         | 33%      | 100%    | 3x increase      |
| Navigation depth       | 2 levels | 1 level | 50% reduction    |

### Qualitative Targets

- [ ] All content visible without clicking
- [ ] Breadcrumbs show current location
- [ ] Quick actions are discoverable
- [ ] Role-based defaults improve efficiency
- [ ] Navigation feels faster and more fluid

---

## Implementation Timeline

### Week 1: Foundation

- [ ] Create new components (TopNav, QuickActionsBar, Breadcrumb)
- [ ] Update uiStore with new schema
- [ ] Create URL redirect system
- [ ] Update router hook

### Week 2: Pages

- [ ] Create Dashboard page
- [ ] Rename Code Explorer to Code
- [ ] Redesign Planning page
- [ ] Extract Team page
- [ ] Extract Retro page

### Week 3: Integration & Testing

- [ ] Update App.tsx
- [ ] Add CSS styles
- [ ] Write unit tests
- [ ] Write integration tests
- [ ] Write E2E tests
- [ ] Accessibility audit

### Week 4: Launch

- [ ] Feature flags
- [ ] Analytics integration
- [ ] Beta rollout
- [ ] Monitor metrics
- [ ] Fix bugs
- [ ] Full rollout

---

## Open Questions for Team Discussion

1. **Role Detection:** How do we detect user role?
   - Manual selection in settings?
   - Infer from ticket assignment?
   - Add role field to agent schema?

2. **Default Page:** Remember last page or use role-based default?
   - Session storage for last page?
   - Role-based on first visit, then remember?
   - Always role-based?

3. **Sprint Auto-Selection:** Auto-select active sprint on Dashboard?
   - Always select active sprint?
   - Allow user to pin different sprint?
   - No auto-selection (current behavior)?

4. **Vision Placement:** Top-level tab or nested in Planning?
   - Top-level tab (flat nav)?
   - Planning sub-tab (current)?
   - Inline in Planning page (proposed)?

---

## Next Steps

1. **Review Design:** Team reviews all three documents
2. **Create Figma Mockups:** Visual designer creates high-fidelity mockups
3. **User Testing:** Test wireframes with real users
4. **Iterate:** Refine based on feedback
5. **Begin Implementation:** Start Phase 1

---

## Files Created

```
docs/ux/
├─ navigation-flattening.md          (Comprehensive spec)
└─ navigation-wireframes.md          (Visual designs)
```

## Files to Modify

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
│     ├─ SprintDetail.tsx (MODIFY - add quickFilter prop)
│     ├─ TeamGrid.tsx (UNCHANGED)
│     └─ BentoGrid.tsx (UNCHANGED)
├─ pages/
│  ├─ Dashboard.tsx (NEW)
│  ├─ Code.tsx (RENAMED from CodeExplorer.tsx)
│  ├─ Planning.tsx (MODIFIED)
│  ├─ Team.tsx (NEW, extracted from Sprint.tsx)
│  ├─ Retro.tsx (NEW, extracted from Sprint.tsx)
│  ├─ Sprint.tsx (DEPRECATED)
│  └─ ProjectManagement.tsx (DEPRECATED)
├─ stores/
│  └─ uiStore.ts (MODIFIED)
├─ hooks/
│  ├─ useHashRouter.ts (MODIFIED)
│  └─ useLegacyRedirect.tsx (NEW)
├─ App.tsx (MODIFIED)
└─ globals.css (MODIFIED)
```

---

## Dependencies

None required. All changes use existing dependencies:

- React 18+
- Zustand (state management)
- Framer Motion (animations)
- TypeScript

---

## Risk Assessment

| Risk                           | Likelihood | Impact | Mitigation                       |
| ------------------------------ | ---------- | ------ | -------------------------------- |
| User confusion with new layout | Medium     | Medium | Beta rollout, feedback widget    |
| URL breakage                   | Low        | High   | Comprehensive redirects, testing |
| Performance regression         | Low        | Medium | Code splitting, lazy loading     |
| Accessibility issues           | Low        | High   | WCAG audit, keyboard testing     |
| Store migration bugs           | Medium     | Medium | Thorough testing, rollback plan  |

**Overall Risk Level:** MEDIUM

**Recommendation:** Proceed with feature flag rollout and monitor closely.

---

## Contact

**Designer:** UX Designer Agent (Sprint 15)
**Questions:** Review open questions section above
**Feedback:** Create GitHub issue for design discussion

---

**Document Version:** 1.0
**Last Updated:** 2026-03-27
**Status:** Design Complete ✓
