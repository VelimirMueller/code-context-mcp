import { alpha, extraUsed } from "../lib/index.js";
import type { Shape } from "../lib/core.js";
import * as ns from "../lib/ns.js";

export function run(s: Shape): string {
  return alpha(s) + extraUsed() + ns.nsA();
}
