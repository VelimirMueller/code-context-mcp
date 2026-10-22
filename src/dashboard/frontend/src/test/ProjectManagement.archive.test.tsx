import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Epic, Milestone } from '@/types';

// Planning page + EpicList archive behaviour (v2.6.0): archived milestones/epics are
// hidden by default, a toggle reveals them, completed rows offer Archive and archived
// rows offer Unarchive.

let planningState: any;
const archiveMilestoneMock = vi.fn(async () => {});
const unarchiveMilestoneMock = vi.fn(async () => {});

vi.mock('@/stores/planningStore', () => ({
  usePlanningStore: (sel: any) => sel(planningState),
}));

let epicsResponse: Epic[] = [];
const postMock = vi.fn(async () => ({ ok: true }));
vi.mock('@/lib/api', () => ({
  get: vi.fn(async (path: string) => (path === '/api/epics' ? epicsResponse : [])),
  post: (...args: unknown[]) => postMock(...(args as [])),
  put: vi.fn(async () => ({})),
}));

function ms(over: Partial<Milestone> & { id: number }): Milestone {
  return { name: `Milestone ${over.id}`, description: null, status: 'active', target_date: null, progress: 0, ticket_count: 0, done_count: 0, archived_at: null, ...over };
}
function ep(over: Partial<Epic> & { id: number }): Epic {
  return { name: `Epic ${over.id}`, description: null, status: 'active', milestone_id: null, color: '#3b82f6', priority: 0, ticket_count: 0, done_count: 0, created_at: '2026-01-01', archived_at: null, ...over };
}

async function renderPage(milestones: Milestone[], epics: Epic[]) {
  epicsResponse = epics;
  planningState = {
    milestones,
    fetchMilestones: vi.fn(),
    archiveMilestone: archiveMilestoneMock,
    unarchiveMilestone: unarchiveMilestoneMock,
  };
  const { ProjectManagement } = await import('@/pages/ProjectManagement');
  render(<ProjectManagement />);
  await waitFor(() => expect(screen.queryByText('Loading epics...')).toBeNull());
}

describe('Planning page milestone archive', () => {
  beforeEach(() => {
    archiveMilestoneMock.mockClear();
    unarchiveMilestoneMock.mockClear();
    postMock.mockClear();
  });

  it('shows active + completed milestones, hides archived ones until the toggle is opened', async () => {
    await renderPage(
      [ms({ id: 1, name: 'Live' }), ms({ id: 2, name: 'Finished', status: 'completed' }), ms({ id: 3, name: 'Shelved', status: 'completed', archived_at: '2026-10-01' })],
      [],
    );
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('Finished')).toBeTruthy();
    expect(screen.queryByText('Shelved')).toBeNull();
    fireEvent.click(screen.getByText(/Archived \(1\)/));
    expect(screen.getByText('Shelved')).toBeTruthy();
  });

  it('offers Archive only on completed milestones and calls the store', async () => {
    await renderPage([ms({ id: 1, name: 'Live' }), ms({ id: 2, name: 'Finished', status: 'completed' })], []);
    const buttons = screen.getAllByRole('button', { name: 'Archive' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(archiveMilestoneMock).toHaveBeenCalledWith(2));
  });

  it('offers Unarchive inside the archive section', async () => {
    await renderPage([ms({ id: 3, name: 'Shelved', status: 'completed', archived_at: '2026-10-01' })], []);
    fireEvent.click(screen.getByText(/Archived \(1\)/));
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(unarchiveMilestoneMock).toHaveBeenCalledWith(3));
  });
});

describe('EpicList archive', () => {
  beforeEach(() => postMock.mockClear());

  it('hides archived epics by default and reveals them behind the toggle', async () => {
    await renderPage([], [ep({ id: 1, name: 'Ongoing' }), ep({ id: 2, name: 'Old epic', status: 'completed', archived_at: '2026-10-01' })]);
    expect(screen.getByText('Ongoing')).toBeTruthy();
    expect(screen.queryByText('Old epic')).toBeNull();
    fireEvent.click(screen.getByText(/Show Archive \(1 archived epics\)/));
    expect(screen.getByText('Old epic')).toBeTruthy();
  });

  it('archives a completed epic and unarchives an archived one via the API', async () => {
    await renderPage([], [ep({ id: 5, name: 'Done epic', status: 'completed' }), ep({ id: 6, name: 'Gone epic', status: 'completed', archived_at: '2026-10-01' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/epic/5/archive', {}));
    fireEvent.click(screen.getByText(/Show Archive/));
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith('/api/epic/6/unarchive', {}));
  });
});
