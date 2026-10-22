# Navigation Flattening — Visual Wireframes

**Created:** 2026-03-27
**Sprint:** 15 (Navigation Flattening)
**Author:** UX Designer Agent

> **Historical specification — Sprint 15 design intent.** This document captures the wireframes as designed during Sprint 15 Navigation Flattening work. The feature shipped, but with the following divergences from this spec that are now the authoritative current state:
>
> - **Tab count:** These wireframes show 5 tabs. The shipped dashboard has **6 tabs**: Dashboard, Planning, Code, Team, Retro, and **Benchmark** (added after Sprint 15). The Benchmark tab is missing from all wireframes in this document.
> - **Header button:** Every wireframe shows a `[⚙ Settings]` button in the top-right of the app header. This button does not exist in the shipped product. The actual header contains an **SSE connection status badge** (a colored dot with the connection state label) and a **`BridgeStatusBadge`** component — no Settings button.
> - **Agent names (Wireframe 3):** The Team page wireframe uses placeholder names ("Backend Dev", "Frontend Dev", "UX Designer") that were never the real agent identifiers. The 9 real agents seeded by `src/scrum/defaults.ts` are: **FE Engineer** (`fe-engineer`), **BE Engineer** (`be-engineer`), **Developer** (`developer`), **DevOps** (`devops`), **QA Engineer** (`qa`), **Security Engineer** (`security`), **Architect** (`architect`), **Team Lead** (`team-lead`), **Product Owner** (`product-owner`).
>
> Do not use this document as a reference for the current UI. Consult `src/dashboard/frontend/src/components/molecules/TopNav.tsx` and `src/dashboard/frontend/src/App.tsx` for authoritative current navigation structure.

---

## Wireframe 1: Dashboard (Desktop)

**Context:** Developer landing on dashboard after flattening

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                        │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│  │  [🔷] Code Context MCP                                              [⚙ Settings]  │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│  │  [📊 Dashboard]  [📁 Code]  [🎯 Planning]  [👥 Team]  [⚡ Retro]                 │ │
│  │      ↑ ACTIVE                                                                      │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│  │  Dashboard > Sprint Board (Active)     [My Tickets: 5] [Blockers: 2!] [QA: 3] [+]│ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                                    │ │
│  │    Sprint 2026-03-24 — 4/7 tickets shipped, 12pt velocity                         │ │
│  │                                                                                    │ │
│  │  ┌────────────────────────────────────────────────────────────────────────────┐  │ │
│  │  │  SPRINTS                                          SPRINT DETAIL             │  │ │
│  │  │  ┌──────────────────────────────────────┐  ┌─────────────────────────────┐│  │ │
│  │  │  │ 🟢 Sprint 2026-03-24  (Active)      │  │  ┌─────────────────────────┐ ││  │ │
│  │  │  │    4/7 tickets • 12/19 pts          │  │  │  Kanban Board           │ ││  │ │
│  │  │  ├─────────────────────────────────────┤  │  │  (My Tickets Filter)    │ ││  │ │
│  │  │  │ ⚪ Sprint 2026-03-17                │  │  │                         │ ││  │ │
│  │  │  │    7/7 tickets • 19/19 pts          │  │  │  ┌──────┐ ┌──────┐      │ ││  │ │
│  │  │  ├─────────────────────────────────────┤  │  │  │ TODO │ │ IN   │      │ ││  │ │
│  │  │  │ ⚪ Sprint 2026-03-10                │  │  │  │  (1) │ │PROG  │      │ ││  │ │
│  │  │  │    6/7 tickets • 15/19 pts          │  │  │  └──────┘ └──────┘      │ ││  │ │
│  │  │  └─────────────────────────────────────┘  │  │  ┌──────┐ ┌──────┐      │ ││  │ │
│  │  │                                           │  │  │ DONE │ │BLOCK  │      │ ││  │ │
│  │  │                                           │  │  │  (2) │ │ED (0) │      │ ││  │ │
│  │  │                                           │  │  └──────┘ └──────┘      │ ││  │ │
│  │  │                                           │  │                         │ ││  │ │
│  │  │                                           │  │  [Show All Tickets]    │ ││  │ │
│  │  │                                           │  └─────────────────────────┘ ││  │ │
│  │  │                                           │                             ││  │ │
│  │  └───────────────────────────────────────────┴─────────────────────────────┘│  │ │
│  │                                                                                    │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key Features:**
- Single-level navigation (5 tabs shown here; **6 tabs shipped** — Benchmark tab not shown in this wireframe)
- Quick actions with count badges
- Breadcrumb showing location
- Auto-selected active sprint
- "My Tickets" filter applied by default
- One click to blockers, QA, new ticket

---

## Wireframe 2: Planning Page (Desktop)

**Context:** Tech Lead viewing roadmap and timeline

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                        │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│  │  [🔷] Code Context MCP                                              [⚙ Settings]  │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│  │  [📊 Dashboard]  [📁 Code]  [🎯 Planning]  [👥 Team]  [⚡ Retro]                 │ │
│  │                                ↑ ACTIVE                                            │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│  │  Planning > Roadmap                     [Search milestones...] [+ Plan Sprint]    │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                                    │ │
│  │    Milestone "Navigation Flattening" — 75% complete                               │ │
│  │                                                                                    │ │
│  │  ┌────────────────────────────────────────────────────────────────────────────┐  │ │
│  │  │  MILESTONES (240px)          ROADMAP & TIMELINE                             │  │ │
│  │  │  ┌─────────────────────────┐  ┌──────────────────────────────────────────┐ │  │ │
│  │  │  │ 🔵 Nav Flattening       │  │  ┌─────────────────────────────────────┐ │ │  │ │
│  │  │  │    75% • 3 sprints       │  │  │  Gantt Chart Timeline              │ │ │  │ │
│  │  │  ├─────────────────────────┤  │  │                                     │ │ │  │ │
│  │  │  │ ⚪ QA Workflow           │  │  │  Mar 24 ────────┐                     │ │ │  │ │
│  │  │  │    40% • 2 sprints       │  │  │  Mar 31 ──────┐│ Sprint 15           │ │  │ │
│  │  │  ├─────────────────────────┤  │  │  Apr 07 ───┐ ││                     │ │ │  │ │
│  │  │  │ ⚪ Performance           │  │  │             │ ▼│                     │ │ │  │ │
│  │  │  │    0% • Planned          │  │  │  M1     M2   M3                     │ │ │  │ │
│  │  │  ├─────────────────────────┤  │  │  │      │    │                      │ │ │  │ │
│  │  │  │ ⚪ Analytics            │  │  │  ▼      ▼    ▼                      │ │ │  │ │
│  │  │  │    0% • Planned          │  │  │ 75%   40%   0%                     │ │ │  │ │
│  │  │  └─────────────────────────┘  │  │                                     │ │ │  │ │
│  │  │                               │  │  ┌─────────────────────────────────┐ │ │  │ │
│  │  │                               │  │  │ [Timeline] [Vision] [Details]  │ │ │  │ │
│  │  │                               │  │  └─────────────────────────────────┘ │ │  │ │
│  │  │                               │  └─────────────────────────────────────┘ │ │  │ │
│  │  └───────────────────────────────┴──────────────────────────────────────────┘ │  │ │
│  │                                                                                    │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key Features:**
- Split view: Milestones (left) + Gantt (right)
- No nested tabs — single level
- Milestone progress percentages
- Timeline with milestone boundaries
- Quick access to Vision, Timeline views

---

## Wireframe 3: Team Page (Desktop)

**Context:** Anyone viewing team capacity and mood

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                        │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│  │  [🔷] Code Context MCP                                              [⚙ Settings]  │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│  │  [📊 Dashboard]  [📁 Code]  [🎯 Planning]  [👥 Team]  [⚡ Retro]                 │ │
│  │                                          ↑ ACTIVE                                │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│  │  Team > Agent Grid                      [Filter by role...] [+ Add Agent]         │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                                    │ │
│  │    9 agents active — 87 average mood                                              │ │
│  │                                                                                    │ │
│  │  ┌────────────────────────────────────────────────────────────────────────────┐  │ │
│  │  │                                                                             │  │ │
│  │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            │  │ │
│  │  │  │  Backend Dev    │  │  Frontend Dev   │  │  UX Designer    │            │  │ │
│  │  │  │  ┌───────────┐  │  │  ┌───────────┐  │  │  ┌───────────┐  │            │  │ │
│  │  │  │  │  😊  92   │  │  │  │  🤔  78   │  │  │  │  😄  95   │  │            │  │ │
│  │  │  │  └───────────┘  │  │  └───────────┘  │  │  └───────────┘  │            │  │ │
│  │  │  │  3 tickets      │  │  2 tickets      │  │  1 ticket       │            │  │ │
│  │  │  │  Available      │  │  In Progress    │  │  Available      │            │  │ │
│  │  │  └─────────────────┘  └─────────────────┘  └─────────────────┘            │  │ │
│  │  │                                                                             │  │ │
│  │  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            │  │ │
│  │  │  │  QA Engineer    │  │  Tech Lead      │  │  Product Owner  │            │  │ │
│  │  │  │  ┌───────────┐  │  │  ┌───────────┐  │  │  ┌───────────┐  │            │  │ │
│  │  │  │  │  😐  85   │  │  │  │  🙂  88   │  │  │  │  😊  91   │  │            │  │ │
│  │  │  │  └───────────┘  │  │  └───────────┘  │  │  └───────────┘  │            │  │ │
│  │  │  │  4 tickets      │  │  Planning        │  │  Vision review  │            │  │ │
│  │  │  │  QA Pending     │  │  Available       │  │  Available      │            │  │ │
│  │  │  └─────────────────┘  └─────────────────┘  └─────────────────┘            │  │ │
│  │  │                                                                             │  │ │
│  │  └─────────────────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                                    │ │
│  └──────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key Features:**
- Grid view of all agents
- Mood indicators with color coding
- Ticket count per agent
- Availability status
- Filter by role
- One click to view agent details

> **Note (divergence):** The agent names shown ("Backend Dev", "Frontend Dev", "UX Designer", etc.) are placeholders used during Sprint 15 design. The 9 real agents are: FE Engineer, BE Engineer, Developer, DevOps, QA Engineer, Security Engineer, Architect, Team Lead, Product Owner.

---

## Wireframe 4: Mobile Layout (Responsive)

**Context:** Developer viewing dashboard on mobile device

```
┌─────────────────────────────┐
│  [🔷] Code Context    [≡]  │
├─────────────────────────────┤
│  [📊] [📁] [🎯] [👥] [⚡]   │
├─────────────────────────────┤
│  Dashboard > Board          │
│  [My 5] [Blockers 2!] [+]   │
├─────────────────────────────┤
│  Sprint 2026-03-24          │
│  4/7 tickets, 12pt          │
├─────────────────────────────┤
│  [Select Sprint ▼]          │
│  ├─ 03-24 (Active) ✓        │
│  ├─ 03-17                   │
│  └─ 03-10                   │
├─────────────────────────────┤
│  ┌───────────────────────┐  │
│  │  Kanban Board         │  │
│  │  (My Tickets)         │  │
│  │                       │  │
│  │  ┌─────────────────┐  │  │
│  │  │ TODO (1)        │  │  │
│  │  │ ┌─────────────┐ │  │  │
│  │  │ │ T-080       │ │  │  │
│  │  │ │ Fix nav bug │ │  │  │
│  │  │ └─────────────┘ │  │  │
│  │  └─────────────────┘  │  │
│  │                       │  │
│  │  ┌─────────────────┐  │  │
│  │  │ DONE (2)        │  │  │
│  │  │ ┌─────────────┐ │  │  │
│  │  │ │ T-078       │ │  │  │
│  │  │ │ Branding    │ │  │  │
│  │  │ └─────────────┘ │  │  │
│  │  │ ┌─────────────┐ │  │  │
│  │  │ │ T-077       │ │  │  │
│  │  │ │ Titles      │ │  │  │
│  │  │ └─────────────┘ │  │  │
│  │  └─────────────────┘  │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

**Key Features:**
- Hamburger menu for additional actions
- Stacked layout for small screens
- Sprint selector as dropdown
- Collapsible Kanban columns
- Touch-optimized buttons (44px minimum)

---

## Wireframe 5: Quick Actions Sheet (Mobile)

**Context:** Developer tapping "More" action on mobile

```
┌─────────────────────────────┐
│  ┌───────────────────────┐  │
│  │  Quick Actions        │  │
│  │  ───────────────────  │  │
│  │                       │  │
│  │  [My Tickets]  5      │  │
│  │  Jump to my work      │  │
│  │                       │  │
│  │  [Blockers]    2      │  │
│  │  View blocked items   │  │
│  │                       │  │
│  │  [QA Pending]  3      │  │
│  │  Needs verification   │  │
│  │                       │  │
│  │  [New Ticket]   +     │  │
│  │  Create ticket        │  │
│  │                       │  │
│  │  [Search]       🔍    │  │
│  │  Find anything        │  │
│  │                       │  │
│  │  ───────────────────  │  │
│  │  [Cancel]             │  │
│  │                       │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

**Key Features:**
- Bottom sheet modal
- Large touch targets
- Count badges
- Clear action labels
- Dismiss on tap outside

---

## Wireframe 6: Navigation State Transitions

**Context:** Showing how navigation changes between states

### State 1: Initial Landing

```
┌─────────────────────────────────────────────────────────────────────┐
│  [📊 Dashboard] [📁 Code] [🎯 Planning] [👥 Team] [⚡ Retro]       │
│      ↑ ACTIVE                                                         │
├─────────────────────────────────────────────────────────────────────┤
│  Dashboard > Sprint Board                                            │
└─────────────────────────────────────────────────────────────────────┘
```

### State 2: After Clicking "Planning"

```
┌─────────────────────────────────────────────────────────────────────┐
│  [📊 Dashboard] [📁 Code] [🎯 Planning] [👥 Team] [⚡ Retro]       │
│                                ↑ ACTIVE                             │
├─────────────────────────────────────────────────────────────────────┤
│  Planning > Roadmap                                                │
└─────────────────────────────────────────────────────────────────────┘
```

### State 3: After Clicking "My Tickets" Quick Action

```
┌─────────────────────────────────────────────────────────────────────┐
│  [📊 Dashboard] [📁 Code] [🎯 Planning] [👥 Team] [⚡ Retro]       │
│      ↑ ACTIVE                                                         │
├─────────────────────────────────────────────────────────────────────┤
│  Dashboard > Sprint Board  │  [My Tickets ✓] [Blockers] [QA] [+]   │
└─────────────────────────────────────────────────────────────────────┘
                                    ↑ Active filter
```

### State 4: After Clicking "Blockers" Quick Action

```
┌─────────────────────────────────────────────────────────────────────┐
│  [📊 Dashboard] [📁 Code] [🎯 Planning] [👥 Team] [⚡ Retro]       │
│      ↑ ACTIVE                                                         │
├─────────────────────────────────────────────────────────────────────┤
│  Dashboard > Sprint Board  │  [My Tickets] [Blockers ✓!] [QA] [+] │
└─────────────────────────────────────────────────────────────────────┘
                                        ↑ Active filter + highlight
```

---

## Wireframe 7: Breadcrumb States

**Context:** Showing breadcrumb trails for different pages

### Dashboard

```
Dashboard > Sprint Board (Active)
```

### Dashboard → Specific Sprint

```
Dashboard > Sprint Board > Sprint 2026-03-17 (Closed)
```

### Dashboard → My Tickets Filter

```
Dashboard > Sprint Board > My Tickets (Active)
```

### Planning → Roadmap

```
Planning > Roadmap (Active)
```

### Planning → Timeline

```
Planning > Timeline (Active)
```

### Planning → Vision

```
Planning > Vision (Active)
```

### Team

```
Team > Agent Grid (Active)
```

### Team → Specific Agent

```
Team > Agent Grid > Backend Developer (Active)
```

### Retro

```
Retro > Insights (Active)
```

---

## Wireframe 8: Role-Based Views

### Developer View (Default: Dashboard)

```
┌─────────────────────────────────────────────────────────────────────┐
│  [📊 Dashboard] [📁 Code] [🎯 Planning] [👥 Team] [⚡ Retro]       │
│      ↑ AUTO-SELECTED FOR DEVELOPER                                   │
├─────────────────────────────────────────────────────────────────────┤
│  Dashboard > Sprint Board  │  [My Tickets: 5] [Blockers: 2]        │
├─────────────────────────────────────────────────────────────────────┤
│  Hero: Sprint 2026-03-24 — My tickets: 3 TODO, 1 IN PROGRESS        │
└─────────────────────────────────────────────────────────────────────┘
```

### Tech Lead View (Default: Planning)

```
┌─────────────────────────────────────────────────────────────────────┐
│  [📊 Dashboard] [📁 Code] [🎯 Planning] [👥 Team] [⚡ Retro]       │
│                                ↑ AUTO-SELECTED FOR TECH LEAD         │
├─────────────────────────────────────────────────────────────────────┤
│  Planning > Roadmap                                                │
├─────────────────────────────────────────────────────────────────────┤
│  Hero: 3 active milestones, 2 upcoming sprints                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Product Owner View (Default: Planning)

```
┌─────────────────────────────────────────────────────────────────────┐
│  [📊 Dashboard] [📁 Code] [🎯 Planning] [👥 Team] [⚡ Retro]       │
│                                ↑ AUTO-SELECTED FOR PRODUCT OWNER      │
├─────────────────────────────────────────────────────────────────────┤
│  Planning > Vision                                                 │
├─────────────────────────────────────────────────────────────────────┤
│  Hero: Product Vision — Last updated 2 days ago                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Color System

### Navigation Colors

```
Active Tab:      #10b981 (var(--accent))
Inactive Tab:    #6b7280 (var(--text3))
Hover Tab:       #4b5563 (var(--text2))
Border Bottom:   #10b981 (var(--accent)) — 2px

Background:      #0f172a (var(--surface))
Border:          #1e293b (var(--border))
Text:            #f1f5f9 (var(--text))
```

### Quick Action Colors

```
My Tickets:      #3b82f6 (blue)
Blockers:        #ef4444 (red) — pulsing if > 0
QA Pending:      #f59e0b (orange)
New Ticket:      #10b981 (green)
Search:          #6b7280 (gray)

Badge Background:#ef4444 (red)
Badge Text:      #ffffff (white)
```

### Status Indicator Colors

```
Active Sprint:    #10b981 (green)
Completed Sprint: #6b7280 (gray)
Planned Sprint:   #3b82f6 (blue)

Milestone On Track:  #10b981 (green)
Milestone At Risk:   #f59e0b (orange)
Milestone Off Track: #ef4444 (red)

Mood Excellent:  #10b981 (green) — 90+
Mood Good:       #3b82f6 (blue) — 80-89
Mood Neutral:    #f59e0b (orange) — 70-79
Mood Concerned:  #ef4444 (red) — <70
```

---

## Typography

### Navigation

```
Tab Label:       13.5px, 600 weight, -0.01em letter-spacing
Breadcrumb:      12px, 500 weight
Hero Text:       24px, 700 weight for numbers, 400 for text
Action Button:   13px, 700 weight, -0.01em letter-spacing
```

### Content

```
Heading:         18px, 600 weight
Subheading:      14px, 500 weight
Body:            13px, 400 weight
Small:           11px, 500 weight (uppercase for labels)
```

---

## Spacing System

```
Navigation Height:     48px
Header Height:         40px
Quick Actions Height:  40px
Total Nav Height:      128px

Padding:
  Small:   8px
  Medium:  12px
  Large:   16px
  XLarge:  24px

Gaps:
  Small:   8px
  Medium:  12px
  Large:   16px
```

---

**Document Version:** 1.0
**Last Updated:** 2026-03-27
**Status:** Draft for Review
