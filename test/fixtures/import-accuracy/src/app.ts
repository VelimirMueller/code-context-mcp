import { add } from '@/lib/math';
import type { Num } from './lib/math';
import * as lib from './lib';
// import { old } from './legacy';  <- a comment, not an import

export async function run(): Promise<Num> {
  const { lazy } = await import('./lazy');
  return lazy + add(1, 2) + Object.keys(lib).length;
}
