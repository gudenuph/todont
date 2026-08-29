import { useEffect, useRef, useState } from 'react';
import type { ItemKind } from '../types';

/**
 * Split button: the main half raises the default kind (a bug), the caret opens
 * the rest. Raising a bug is overwhelmingly the common case, so it stays one
 * click, and a feature request is two rather than hidden behind a form choice.
 */
export function RaiseButton({
  kinds,
  onRaise,
}: {
  kinds: ItemKind[];
  onRaise: (kind: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const primary = kinds[0];
  if (!primary) return null;

  return (
    <div className="split" ref={wrap}>
      <button className="btn primary split-main" onClick={() => onRaise(primary.key)}>
        Raise {primary.article}
      </button>
      <button
        className="btn primary split-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More things to raise"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">▾</span>
      </button>

      {open ? (
        <div className="split-menu" role="menu">
          {kinds.map((kind) => (
            <button
              key={kind.key}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onRaise(kind.key);
              }}
            >
              <span className="kind-emoji" aria-hidden="true">
                {kind.emoji}
              </span>
              Raise {kind.article}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
