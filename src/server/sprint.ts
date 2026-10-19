#!/usr/bin/env node
/**
 * The sprint entry (#179): bin `code-context-sprint`.
 *
 * Same server and same context.db as the index entry, with the sprint process
 * on by default: `CODE_CONTEXT_PROFILE` defaults to `full` (97 tools: code,
 * code-admin, scrum — the dashboard bridge and dump/restore ride with scrum).
 * A known `CODE_CONTEXT_PROFILE` (`code`, `full`, `all`) still wins; an unset,
 * empty or unknown one becomes `full`. `CODE_CONTEXT_TOOLSETS` still adds
 * toolsets.
 *
 * The env is set before the server module loads, so every reader of it
 * (toolsets, flair, instructions) sees the same profile.
 */
import { PROFILES } from './tool-wrap.js';

const asked = process.env.CODE_CONTEXT_PROFILE?.trim().toLowerCase() ?? '';
if (!Object.prototype.hasOwnProperty.call(PROFILES, asked)) {
  if (asked) console.error(`[profile] unknown CODE_CONTEXT_PROFILE=${asked}, using full`);
  process.env.CODE_CONTEXT_PROFILE = 'full';
}

await import('./index.js');
