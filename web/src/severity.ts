/**
 * The strip down the left of every card. Severity is the one thing you should
 * be able to read off a board without opening anything, so it gets colour and
 * position rather than a word buried in the card's footer.
 */
export const SEVERITY_COLOR: Record<string, string> = {
  critical: '#ff5a5a', // AccentPlayhead — the only true red in the palette
  major: '#e68c32', // AccentWarning
  minor: '#6e8ca8', // muted slate
  trivial: '#4e4e5e', // barely there, but still distinct from the card border
};

export function severityColor(severity: string): string {
  return SEVERITY_COLOR[severity] ?? SEVERITY_COLOR.trivial;
}
