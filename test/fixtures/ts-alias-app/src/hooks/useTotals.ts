import { formatPrice } from "@/lib/format";

export function useTotals(items: number[]): string {
  return formatPrice(items.reduce((a, b) => a + b, 0));
}
