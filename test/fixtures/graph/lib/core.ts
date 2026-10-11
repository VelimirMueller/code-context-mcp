// Defines everything; reached directly and through lib/index.ts.
export interface Shape {
  kind: string;
}

export function alpha(s: Shape): string {
  return s.kind;
}

export function beta(n: number): number {
  return n * 2;
}

export function gamma(): number {
  return 3;
}

export async function delta(): Promise<number> {
  return 4;
}

export const EPS = 1e-9;
