/**
 * #212: the planning components that no page showed are deleted, and no
 * module of the dashboard app imports them again.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/dashboard/app/src',
);
const REMOVED = [
  'SprintPlanningView',
  'PlanningWizard',
  'MilestoneList',
  'PlanningDashboard',
  'EnhancedGanttChart',
  'SprintBurndownView',
  'EnhancedCapacityView',
  'SprintTableView',
  'PlanningInsights',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(tsx?|jsx?)$/.test(name) ? [p] : [];
  });
}

describe('removed planning components (#212)', () => {
  it.each(REMOVED)('%s has no file and no import', (name) => {
    expect(existsSync(path.join(APP_SRC, 'components/organisms', `${name}.tsx`))).toBe(false);
    const importers = sourceFiles(APP_SRC).filter((f) =>
      new RegExp(`\\b${name}\\b`).test(readFileSync(f, 'utf8')),
    );
    expect(importers.map((f) => path.relative(APP_SRC, f))).toEqual([]);
  });
});
