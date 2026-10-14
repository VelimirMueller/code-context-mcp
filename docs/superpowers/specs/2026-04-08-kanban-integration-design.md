# Kanban Board Integration — Design Spec

**Date:** 2026-04-08  
**Sprint:** sprint-2026-04-08  
**Tickets:** T-059, T-062

---

## Scope

Two changes to the React dashboard:

1. **T-059** — Add HTML5 drag-to-move to `KanbanBoard.tsx`
2. **T-062** — Add a `kanban` view mode to `PlanningDashboard.tsx`

T-060 (GanttChart) and T-061 (LandingAnimation) already exist and are integrated — mark DONE without code changes. (GanttChart was removed later as unreachable, #227.)

---

## T-059: Drag-to-Move in KanbanBoard

### State

```ts
const [draggingId, setDraggingId] = useState<number | null>(null);
const [dragOverCol, setDragOverCol] = useState<string | null>(null);
const [localTickets, setLocalTickets] = useState<Ticket[]>(tickets);
```

`localTickets` mirrors the `tickets` prop and is the source of truth for rendering. It is updated optimistically on drop and synced when `tickets` prop changes.

### Drag lifecycle

| Event                  | Handler                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| `onDragStart` (card)   | `setDraggingId(ticket.id)`, `e.dataTransfer.setData('ticketId', ticket.id)`      |
| `onDragOver` (column)  | `e.preventDefault()`, `setDragOverCol(status)`                                   |
| `onDragLeave` (column) | `setDragOverCol(null)`                                                           |
| `onDrop` (column)      | Read `ticketId` from dataTransfer, optimistic update, PATCH API, revert on error |
| `onDragEnd` (card)     | `setDraggingId(null)`, `setDragOverCol(null)`                                    |

### Optimistic update + revert

```ts
const handleDrop = async (targetStatus: string) => {
  const ticketId = Number(e.dataTransfer.getData('ticketId'));
  const prev = localTickets; // snapshot for rollback
  setLocalTickets((ts) => ts.map((t) => (t.id === ticketId ? { ...t, status: targetStatus } : t)));
  setDraggingId(null);
  setDragOverCol(null);
  try {
    await patch(`/api/ticket/${ticketId}/status`, { status: targetStatus });
    if (selectedSprintId) fetchTickets(selectedSprintId);
  } catch {
    setLocalTickets(prev); // revert
  }
};
```

### Visual feedback

- Dragged card: `opacity: 0.4`, `cursor: grabbing`
- Card `cursor: grab` at rest
- Drop column on hover: `border-color: var(--accent)`, `background: rgba(16,185,129,0.06)`

### Prop sync

```ts
useEffect(() => {
  setLocalTickets(tickets);
}, [tickets]);
```

---

## T-062: Kanban View in PlanningDashboard

### ViewMode extension

```ts
type ViewMode = 'overview' | 'gantt' | 'burndown' | 'capacity' | 'table' | 'kanban';
```

### viewModes array addition

```ts
{ id: 'kanban', label: 'Kanban', icon: '⊞' }
```

### State

```ts
const [kanbanTickets, setKanbanTickets] = useState<Ticket[]>([]);
const [loadingKanban, setLoadingKanban] = useState(false);
```

### Data fetch on view switch

```ts
useEffect(() => {
  if (viewMode !== 'kanban' || !selectedSprintId) return;
  setLoadingKanban(true);
  get<Ticket[]>(`/api/sprint/${selectedSprintId}/tickets`)
    .then((data) => setKanbanTickets(Array.isArray(data) ? data : []))
    .catch(() => setKanbanTickets([]))
    .finally(() => setLoadingKanban(false));
}, [viewMode, selectedSprintId]);
```

### Render section

```tsx
{
  viewMode === 'kanban' && (
    <div style={{ padding: '0 8px' }}>
      {loadingKanban ? (
        <div style={{ color: 'var(--text3)', padding: 32 }}>Loading…</div>
      ) : (
        <KanbanBoard tickets={kanbanTickets} />
      )}
    </div>
  );
}
```

### Import

```ts
import { KanbanBoard } from './KanbanBoard';
```

---

## Files Changed

| File                                             | Change                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `src/components/organisms/KanbanBoard.tsx`       | Add drag state, event handlers, optimistic update, visual cues            |
| `src/components/organisms/PlanningDashboard.tsx` | Add `kanban` to ViewMode, add view tab, fetch tickets, render KanbanBoard |

---

## Out of Scope

- Touch/mobile drag (HTML5 drag events don't fire on touch — acceptable for desktop tool)
- Drag-to-reorder within a column
- Keyboard drag accessibility
