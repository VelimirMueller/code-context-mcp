export function formatPrice(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "-");
}

export function unusedFormatter(): string {
  return "";
}
