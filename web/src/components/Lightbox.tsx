import { useEffect, useState } from 'react';

export interface LightboxImage {
  url: string;
  name: string;
}

/**
 * An attachment at full size.
 *
 * A screenshot is usually the whole point of a bug report, and a thumbnail the
 * width of a card is not something you can read an error message off. Opening
 * it in a new tab worked but threw away the context — this keeps the ticket
 * underneath and gets out of the way on Escape.
 */
export function Lightbox({
  images,
  index,
  onClose,
}: {
  images: LightboxImage[];
  index: number;
  onClose: () => void;
}) {
  const [at, setAt] = useState(index);

  // Reopening on a different image should show that one, not the last.
  useEffect(() => setAt(index), [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setAt((i) => (i + 1) % images.length);
      if (e.key === 'ArrowLeft') setAt((i) => (i - 1 + images.length) % images.length);
    };

    window.addEventListener('keydown', onKey);
    // The page behind must not scroll while this is over it.
    const scroll = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = scroll;
    };
  }, [images.length, onClose]);

  const image = images[at];
  if (!image) return null;

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label={image.name}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close">
        ×
      </button>

      {images.length > 1 ? (
        <>
          <button
            className="lightbox-step prev"
            aria-label="Previous image"
            onClick={(e) => {
              e.stopPropagation();
              setAt((i) => (i - 1 + images.length) % images.length);
            }}
          >
            ‹
          </button>
          <button
            className="lightbox-step next"
            aria-label="Next image"
            onClick={(e) => {
              e.stopPropagation();
              setAt((i) => (i + 1) % images.length);
            }}
          >
            ›
          </button>
        </>
      ) : null}

      {/* Clicking the picture itself should not close what you opened to look at. */}
      <img
        className="lightbox-image"
        src={image.url}
        alt={image.name}
        onClick={(e) => e.stopPropagation()}
      />

      <div className="lightbox-caption" onClick={(e) => e.stopPropagation()}>
        <span>{image.name}</span>
        {images.length > 1 ? (
          <span className="lightbox-count">
            {at + 1} of {images.length}
          </span>
        ) : null}
        <a href={image.url} target="_blank" rel="noreferrer">
          Open the file
        </a>
      </div>
    </div>
  );
}
