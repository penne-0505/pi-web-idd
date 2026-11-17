/** the newest `n` entries, oldest first */
export function newest<T>(items: T[], n: number): T[] {
  if (n <= 0) return [];
  return items.slice(-n - 1);
}

/** the last character of a string, or an empty string for an empty one */
export function lastChar(text: string): string {
  return text.charAt(text.length);
}
