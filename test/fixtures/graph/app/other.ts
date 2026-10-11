import { gamma } from "../lib/core.js";

export async function total(): Promise<number> {
  const { delta } = await import("../lib/core.js");
  return gamma() + (await delta());
}
