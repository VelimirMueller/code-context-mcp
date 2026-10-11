// Shapes fixture for get_file_context signatures (CCA-04).
import fs from "node:fs";
import {
  readConfig,
  type Config,
} from "./config.js";
import "./side-effect.js";
export * from "./reexported.js";

/** A point. */
export interface Point extends Base<number> {
  x: number;
  y: number;
}

export type Shape =
  | { kind: "circle"; r: number }
  | { kind: "square"; side: number };

export enum Color { Red, Green }

export async function loadShapes<T extends Shape>(
  file: string,
  opts: { strict?: boolean } = {},
): Promise<{ shapes: T[]; color: Color }> {
  const raw = fs.readFileSync(file, "utf-8");
  return { shapes: JSON.parse(raw), color: Color.Red };
}

export const area = (s: Shape): number => {
  return s.kind === "circle" ? Math.PI * s.r ** 2 : s.side ** 2;
};

export const DEFAULTS: Config = {
  strict: true,
};

export default class ShapeStore extends Map<string, Shape> implements Iterable<[string, Shape]> {
  load(): void {
    readConfig();
  }
}
