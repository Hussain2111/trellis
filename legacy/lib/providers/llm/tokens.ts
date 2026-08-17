/**
 * Cheap token estimate. A real tokeniser would be more accurate, but the only
 * consumer is the Tier B ceiling, which exists to catch order-of-magnitude
 * mistakes ("I just passed 40 captions to a 4B model"), not to be exact.
 *
 * ~4 characters per token for English prose, with a floor on whitespace-heavy
 * input so JSON and tables aren't undercounted.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const byChars = text.length / 4;
  const byWords = text.trim().split(/\s+/).length * 1.3;
  return Math.ceil(Math.max(byChars, byWords));
}

export function estimateRequestTokens(parts: (string | undefined)[]): number {
  return parts.reduce<number>((sum, p) => sum + estimateTokens(p ?? ''), 0);
}
