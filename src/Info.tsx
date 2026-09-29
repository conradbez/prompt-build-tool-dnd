import { useRef, useState, type ReactNode } from 'react';

const WIDTH = 300;
const MARGIN = 8;

/**
 * An "i" beside a heading whose explanation shows on hover or focus. The
 * settings screens used to carry a paragraph of small print under every
 * section; the fields read better on their own, with the why one hover away.
 *
 * The bubble is fixed-position and placed from the icon's own rectangle, so a
 * scrolling modal body cannot clip it, and it is kept inside the window.
 */
export function Info({ children, label = 'More about this' }: { children: ReactNode; label?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [at, setAt] = useState<{ top: number; left: number; above: boolean } | null>(null);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(MARGIN, r.left + r.width / 2 - WIDTH / 2), window.innerWidth - WIDTH - MARGIN);
    // Below the icon, unless that would run off the bottom of the window.
    const above = r.bottom + 160 > window.innerHeight;
    setAt({ top: above ? r.top - 6 : r.bottom + 6, left, above });
  };
  const hide = () => setAt(null);

  return (
    <span
      ref={ref}
      className="info"
      tabIndex={0}
      role="button"
      aria-label={label}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      // A tap on touch has no hover: toggle instead.
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (at) hide();
        else show();
      }}
    >
      i
      {at && (
        <span
          className={`info__pop${at.above ? ' info__pop--above' : ''}`}
          role="tooltip"
          style={{ top: at.top, left: at.left, width: WIDTH }}
        >
          {children}
        </span>
      )}
    </span>
  );
}
