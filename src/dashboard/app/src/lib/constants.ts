export interface ModelOption {
  value: string;
  label: string;
  short: string;
  description: string;
  color: string;
}

/** Current-generation models offered for new assignments. Single source of truth for the dashboard UI. */
export const MODEL_OPTIONS: readonly ModelOption[] = [
  { value: 'claude-fable-5', label: 'Fable 5', short: 'fable 5', description: 'Most capable', color: '#f472b6' },
  { value: 'claude-opus-5', label: 'Opus 5', short: 'opus 5', description: 'Powerful', color: '#a5b4fc' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', short: 'sonnet 5', description: 'Balanced', color: '#60a5fa' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5', short: 'haiku 4.5', description: 'Fast', color: '#10b981' },
];

export const DEFAULT_AGENT_MODEL = 'claude-sonnet-5';

/** Superseded models that may still be set on existing agents — rendered, but not offered for new picks. */
const LEGACY_MODELS: readonly ModelOption[] = [
  { value: 'claude-opus-4-8', label: 'Opus 4.8', short: 'opus 4.8', description: 'Powerful (previous gen)', color: '#a5b4fc' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', short: 'sonnet 4.6', description: 'Balanced (previous gen)', color: '#60a5fa' },
];

export const MODEL_COLORS: Record<string, string> = Object.fromEntries(
  [...MODEL_OPTIONS, ...LEGACY_MODELS].map((m) => [m.value, m.color]),
);

export const MODEL_SHORT_LABELS: Record<string, string> = Object.fromEntries(
  [...MODEL_OPTIONS, ...LEGACY_MODELS].map((m) => [m.value, m.short]),
);

export const PAGES = ['explorer', 'planning', 'sprint'] as const;
export type PageId = typeof PAGES[number];

export const PAGE_LABELS: Record<PageId, string> = {
  explorer: 'Code Explorer',
  planning: 'Project Management',
  sprint: 'Sprint',
};
