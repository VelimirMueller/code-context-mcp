# UX Documentation Index

> **Warning:** Historical design spec (Sprint 15). Implemented in Sprint 16 with divergences — see below. Not current-state documentation.
>
> **Key divergences from this spec (verified against source as of Sprint 20 / v1.2.1):**
>
> - **6 tabs shipped, not 5.** The spec assumed five tabs (Dashboard, Code, Planning, Team, Retro). A sixth tab — Benchmark — was added. The `TopNav` type union is `'dashboard' | 'code' | 'planning' | 'team' | 'retro' | 'benchmark'` and all six appear in `navItems` (`src/dashboard/app/src/components/molecules/TopNav.tsx`).
> - **Nav components are prop-driven, not store-driven.** The spec called for `TopNav` to consume the Zustand store directly. The shipped `TopNav` is a pure presentational component: it receives `activeTab` and `onTabChange` as props, and `App.tsx` is responsible for bridging those to the store. `SubTabBar` falls back to the store only when no `active`/`onChange` props are passed.
> - **Page files kept their original names.** The spec planned to rename `ProjectManagement.tsx` → `Planning.tsx` and `CodeExplorer.tsx` → `Code.tsx`. The implemented files remain `ProjectManagement.tsx` and `CodeExplorer.tsx`. `App.tsx` maps the `planning` tab to `<ProjectManagement />` and the `code` tab to `<CodeExplorer />` at runtime.
> - **SVG icons, not emoji.** The spec used emoji glyphs as tab icons. The implementation uses inline SVG paths throughout `TopNav` with an explicit comment: "Clean SVG icons — no emoji rendering inconsistencies."
> - **Query-param redirects were not built.** The spec described URL redirect rules using query parameters. The shipped `useHashRouter` and the `legacyUrlMap` in `App.tsx` perform hash-path redirects only (e.g. `#sprint` → `#dashboard`). Query-param routing was considered (the code strips `?`-suffixes before lookup) but never implemented as standalone redirect rules.
> - **SubTabBar is still in use, not deprecated.** The spec listed `SubTabBar.tsx` as a component to be deprecated. It remains at `src/dashboard/app/src/components/molecules/SubTabBar.tsx` and is actively used for within-page sub-navigation on multiple pages.

**Repository:** Code Context MCP Dashboard
**Last Updated:** 2026-03-27
**Sprint:** 15 (Navigation Flattening)

---

## Overview

This directory contains comprehensive UX documentation for the Code Context MCP dashboard, including user journey analysis, navigation flattening designs, and implementation guides.

---

## Documents

### 1. User Journey Map

**File:** `ux-user-journey-map.md` _(planned in Sprint 14 — never committed; not in this repo)_
**Created:** Sprint 14
**Author:** UX Designer Agent

**Contents:**

- Current state analysis
- Critical UX issues identification
- 5 detailed user journey maps
- Component inventory
- Design system guidelines
- Priority recommendations

**Key Findings:**

- 7 clicks to find assigned work (target: 2-3)
- Missing sprint status indicators
- Navigation depth issues
- Gantt chart visual clarity problems

---

### 2. Navigation Flattening (Sprint 15)

**Primary:** [`navigation-flattening-summary.md`](./navigation-flattening-summary.md)

#### 2.1 Comprehensive Design Specification

**File:** [`navigation-flattening.md`](./navigation-flattening.md)
**Size:** ~1,200 lines
**Author:** UX Designer Agent

**Contents:**

- Current vs. proposed navigation architecture
- Component specifications (TopNav, QuickActionsBar, Breadcrumb)
- URL migration strategy
- Store schema updates
- Visual design specifications
- Responsive layouts
- Accessibility checklist
- Performance considerations
- Success criteria

**Key Decisions:**

- Single-level navigation (5 tabs always visible)
- Persistent quick actions bar
- Role-based default tabs
- URL redirects for backward compatibility

#### 2.2 Visual Wireframes

**File:** [`navigation-wireframes.md`](./navigation-wireframes.md)
**Size:** ~800 lines
**Author:** UX Designer Agent

**Contents:**

- 8 detailed ASCII wireframes
- Desktop, tablet, and mobile layouts
- Navigation state transitions
- Role-based view examples
- Color system specification
- Typography scale
- Spacing system

**Visual Specs:**

- Navigation height: 48px
- Quick actions height: 40px
- Total nav height: 128px (including header)
- Active tab: var(--accent) color, 2px bottom border
- Badge count: 14px circular, red background

#### 2.3 Implementation Migration Guide (removed)

The Sprint 15 implementation guide was removed in #231. Its code samples imported dashboard modules that no longer exist, and the shipped navigation differs from the plan. The current dashboard structure is in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).

---

## Quick Reference

### Navigation Architecture

**Before (Nested - 2 levels):**

```
App.tsx → Sprint → [Board, Team, Insights]
App.tsx → Project Management → [Milestones, Vision, Gantt, Insights]
```

**After (Flat - 1 level):**

```
TopNav → [Dashboard, Code, Planning, Team, Retro]
```

### Key Metrics

| Metric                 | Before   | After   | Improvement |
| ---------------------- | -------- | ------- | ----------- |
| Clicks to find tickets | 7        | 2-3     | 57-71%      |
| Time to first action   | 8s       | 3s      | 62.5%       |
| Tab visibility         | 33%      | 100%    | 3x          |
| Navigation depth       | 2 levels | 1 level | 50%         |

### Component Inventory

**New Components:**

- `TopNav.tsx` - Single-level navigation
- `QuickActionsBar.tsx` - Persistent action bar
- `Breadcrumb.tsx` - Location indicator
- `Dashboard.tsx` - Combined Sprint Board page
- `Team.tsx` - Extracted Team page
- `Retro.tsx` - Extracted Retro page

**Modified Components:**

- `App.tsx` - Use new navigation
- `uiStore.ts` - Updated schema
- `Planning.tsx` - Redesigned layout
- `useHashRouter.ts` - Query param support

**Deprecated Components:**

- `Sprint.tsx` - Content moved to Dashboard
- `ProjectManagement.tsx` - Renamed to Planning
- `SubTabBar.tsx` - No longer needed

---

## Design System

### Colors

| Purpose      | Color         | Hex     | Usage                |
| ------------ | ------------- | ------- | -------------------- |
| Active Tab   | var(--accent) | #10b981 | Active navigation    |
| Inactive Tab | var(--text3)  | #6b7280 | Inactive navigation  |
| Hover Tab    | var(--text2)  | #4b5563 | Hover state          |
| Blockers     | #ef4444       | red     | Urgent items         |
| QA Pending   | #f59e0b       | orange  | Pending verification |
| My Tickets   | #3b82f6       | blue    | Assigned work        |

### Typography

| Element       | Size   | Weight | Usage           |
| ------------- | ------ | ------ | --------------- |
| Nav Label     | 13.5px | 600    | Navigation tabs |
| Breadcrumb    | 12px   | 500    | Location trail  |
| Hero Text     | 24px   | 700    | Page headers    |
| Action Button | 13px   | 700    | Quick actions   |

### Spacing

| Element       | Size  | Usage           |
| ------------- | ----- | --------------- |
| Navigation    | 48px  | Top nav bar     |
| Quick Actions | 40px  | Action bar      |
| Header        | 40px  | Logo bar        |
| Total         | 128px | Full nav height |

---

## Implementation Status

### Sprint 14 (Completed)

- [x] User journey analysis
- [x] Critical UX issues identified
- [x] Design system guidelines

### Sprint 15 (In Progress - Design Phase)

- [x] Navigation flattening design
- [x] Visual wireframes
- [x] Implementation guide
- [ ] Team review
- [ ] Figma mockups
- [ ] User testing
- [ ] Implementation begins

### Sprint 15-16 (Planned)

- [ ] Component creation
- [ ] Store updates
- [ ] Page development
- [ ] Integration
- [ ] Testing
- [ ] Launch

---

## Related Tickets

| Ticket | Title                       | Points | Status          |
| ------ | --------------------------- | ------ | --------------- |
| #1793  | Design flattened navigation | 5sp    | Design Complete |
| #1794  | Design quick actions bar    | 3sp    | Design Complete |
| #1795  | Create migration guide      | 3sp    | Design Complete |

---

## Open Questions

1. **Role Detection:** How to detect user role?
   - Manual selection?
   - Infer from tickets?
   - Add to agent schema?

2. **Default Page:** Remember last page or role-based?
   - Session storage?
   - Hybrid approach?

3. **Sprint Auto-Selection:** Auto-select active sprint?
   - Always auto-select?
   - Allow pinning?

4. **Vision Placement:** Top-level or nested?
   - Flat nav tab?
   - Planning sub-tab?

**Discussion:** Create GitHub issue for each question

---

## Contributing

When updating UX documentation:

1. Keep files in sync (summary + detailed docs)
2. Update this index
3. Add version and date stamps
4. Cross-reference related documents
5. Maintain ASCII wireframes for accessibility

---

## Resources

### Design Tools

- Figma (for high-fidelity mockups)
- Excalidraw (for wireframes)
- Framer Motion (animations)

### Development Tools

- React DevTools
- Zustand DevTools
- Chrome Lighthouse (accessibility)

### References

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [React Documentation](https://react.dev)
- [Framer Motion API](https://www.framer.com/motion/)
- [Zustand Guide](https://docs.pmnd.rs/zustand)

---

**Maintainer:** UX Designer Agent
**Review Cycle: Each Sprint
**Last Review:** Sprint 15 (2026-03-27)
**Next Review:\*\* Sprint 16 (2026-04-03)
