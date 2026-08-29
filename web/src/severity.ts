import type { ItemKind, Level } from './types';

/**
 * A ticket's level lives in one column but means different things per kind: a
 * bug has a severity, a feature request has how badly someone wants it. The
 * scales come from /api/meta so the card, the form and the dialog agree.
 */
export function levelsOf(kind: ItemKind | undefined): Level[] {
  return kind?.levels ?? [];
}

export function levelOf(kind: ItemKind | undefined, key: string): Level | undefined {
  return kind?.levels.find((l) => l.key === key);
}

/** The strip down the left of a card. Falls back to the card border colour. */
export function levelColor(kind: ItemKind | undefined, key: string): string {
  return levelOf(kind, key)?.color ?? '#3c3c4a';
}

/** What to show the reader — "Major", "Kinda want it" — not the stored key. */
export function levelLabel(kind: ItemKind | undefined, key: string): string {
  return levelOf(kind, key)?.label ?? key;
}

/** The card-footer form, which has only a few characters to play with. */
export function levelShort(kind: ItemKind | undefined, key: string): string {
  return levelOf(kind, key)?.short ?? levelLabel(kind, key);
}
