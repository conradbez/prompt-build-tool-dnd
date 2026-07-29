import { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface TruncatedStatusProps {
  /** Text rendered in the bar; clipped to an ellipsis when it does not fit. */
  text: string;
  /** Full text shown on hover. Defaults to `text`. */
  full?: string;
  /** Which edge the popover is anchored to. */
  align?: 'start' | 'end';
  className?: string;
}

/**
 * Status-bar text that clips to "…" but reveals the whole message on hover.
 * The native `title` tooltip is too slow (and truncates long strings itself),
 * so we render our own popover — only when the text is actually clipped.
 */
export function TruncatedStatus({ text, full, align = 'start', className }: TruncatedStatusProps) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const message = full ?? text;

  const show = useCallback(() => {
    const el = textRef.current;
    // Nothing to reveal when the text already fits, unless the hover text differs.
    const isClipped = !!el && el.scrollWidth > el.clientWidth + 1;
    if (isClipped || message !== text) setOpen(true);
  }, [message, text]);

  return (
    <span
      className="relative min-w-0 inline-flex"
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
      onFocus={show}
      onBlur={() => setOpen(false)}
      tabIndex={0}
    >
      <span ref={textRef} className={cn('truncate', className)}>
        {text}
      </span>
      {open && (
        <span
          role="tooltip"
          className={cn(
            'absolute top-[calc(100%+6px)] z-50 w-max max-w-[420px] whitespace-pre-wrap break-words',
            'rounded-md border bg-white px-2 py-1.5 text-[11px] leading-snug text-foreground shadow-md',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {message}
        </span>
      )}
    </span>
  );
}
