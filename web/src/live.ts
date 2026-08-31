import { useEffect, useLayoutEffect, useRef } from 'react';
import type { BugCard } from './types';

/**
 * Keeping an open board current.
 *
 * A poll rather than a socket: this is a tracker that runs on a small box, and
 * a short GET every twenty seconds costs less — in code and in memory held per
 * viewer — than a connection kept open for each of them. The poll asks only
 * whether anything changed; the board itself is re-read only when something has.
 */

export interface LiveSettings {
  enabled: boolean;
  intervalSeconds: number;
  animate: boolean;
}

/** What happened to a card since the last time we looked. */
export type ChangeKind = 'new' | 'moved' | 'updated';

export const DEFAULT_LIVE: LiveSettings = { enabled: true, intervalSeconds: 20, animate: true };

/**
 * What changed between two readings of the board.
 *
 * Deliberately silent about anything that left: a card that has been merged or
 * deleted is gone from the DOM and has nothing left to animate, and flagging it
 * would only ever be a highlight on empty space.
 */
/**
 * Everything a card actually shows, as one comparable string.
 *
 * The timestamp alone is not enough: `updated_at` is stored to the second, so
 * an edit made in the same second as the change before it leaves it untouched,
 * and a card would visibly change with nothing to say it had. Comparing what is
 * on the card is both stricter and more honest — it marks a card exactly when
 * what you are looking at is different.
 */
function face(card: BugCard): string {
  return [
    card.title,
    card.severity,
    card.kind,
    card.assignee?.id ?? '-',
    card.occurrences,
    card.commentCount,
    card.attachmentCount,
    card.duplicateCount,
    card.blockedBy.join('.'),
    card.blocking.join('.'),
    card.updatedAt,
  ].join('|');
}

export function diffBoard(before: BugCard[], after: BugCard[]): Map<number, ChangeKind> {
  const changes = new Map<number, ChangeKind>();
  const seen = new Map(before.map((b) => [b.id, b]));

  for (const card of after) {
    const was = seen.get(card.id);

    if (!was) {
      changes.set(card.id, 'new');
    } else if (was.status !== card.status) {
      // A lane change is the interesting one, and it animates differently.
      changes.set(card.id, 'moved');
    } else if (face(was) !== face(card)) {
      changes.set(card.id, 'updated');
    }
  }

  return changes;
}

/**
 * Poll for a new board stamp, and say when it differs.
 *
 * Paused while a card is being dragged — re-rendering the board underneath a
 * drag would be both wrong and unpleasant — and while the tab is in the
 * background, where the answer is only wanted the moment somebody looks again.
 */
export function useBoardPolling(options: {
  live: LiveSettings;
  paused: boolean;
  /**
   * The stamp of the data on screen, owned by the caller and set every time it
   * reads the board. Keeping it there rather than here is what closes the gap:
   * the rows and their stamp arrive together, so nothing can change in between
   * and be quietly absorbed into a baseline.
   */
  knownStamp: { current: string | null };
  onChanged: () => void | Promise<void>;
  onSettings?: (live: LiveSettings) => void;
}): void {
  const { live, paused } = options;

  // Kept in a ref so a new callback does not restart the interval.
  const handlers = useRef(options);
  handlers.current = options;

  const busy = useRef(false);

  useEffect(() => {
    if (!live.enabled) return;

    let stopped = false;

    const poll = async () => {
      if (stopped || busy.current) return;
      if (document.visibilityState === 'hidden') return;
      if (handlers.current.paused) return;

      busy.current = true;
      try {
        const res = await fetch('/api/board/version', { credentials: 'same-origin' });
        if (!res.ok) return;

        const data = (await res.json()) as { stamp: string; live: LiveSettings };
        handlers.current.onSettings?.(data.live);

        // Switched off since this tab opened. Take the new policy, then stop —
        // acting on this last answer would push one more change to a board that
        // has just been told not to receive them.
        if (!data.live.enabled) return;

        // Nothing to compare against until the board itself has loaded.
        const known = handlers.current.knownStamp.current;
        if (known !== null && data.stamp !== known) {
          // onChanged re-reads the board, which updates the stamp to whatever
          // that read actually saw — which may already be newer than this one.
          await handlers.current.onChanged();
        }
      } catch {
        /* offline, or the box is restarting: try again on the next tick */
      } finally {
        busy.current = false;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), Math.max(5, live.intervalSeconds) * 1000);

    // Coming back to the tab should feel immediate rather than up to a
    // full interval stale.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [live.enabled, live.intervalSeconds, paused]);
}

const REDUCED = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * FLIP: let the cards land where React puts them, then animate from where they
 * used to be to where they now are.
 *
 * This is what makes a move readable. Without it a card that someone else
 * dragged to another lane simply teleports on the next poll, and you are left
 * working out what you just missed.
 */
export function useCardFlip(enabled: boolean, signal: unknown): void {
  const previous = useRef(new Map<string, DOMRect>());

  useLayoutEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-card]'));
    const next = new Map<string, DOMRect>();
    const animate = enabled && !REDUCED();

    for (const node of nodes) {
      const key = node.dataset.card;
      if (!key) continue;

      const rect = node.getBoundingClientRect();
      next.set(key, rect);

      const old = previous.current.get(key);
      if (!animate || !old) continue;

      const dx = old.left - rect.left;
      const dy = old.top - rect.top;

      // Sub-pixel shifts are reflow, not movement.
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;

      node.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)`, boxShadow: '0 12px 30px rgba(0,0,0,0.45)' },
          { transform: 'translate(0, 0)', boxShadow: 'none' },
        ],
        { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      );
    }

    previous.current = next;
  }, [signal, enabled]);
}
