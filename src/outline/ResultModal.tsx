import { useEffect, useLayoutEffect, useRef } from 'react';
import { renderMarkdown } from '../lib/markdown';
import { displayToRaw, toDisplay } from '../lib/mentions';
import { usePromptVarMap, type PromptVarMap } from '../lib/promptdata';
import { actions, firstLine, getState, titleMap } from '../store';
import { PYTHON_CAPTION, type Bullet } from '../types';

interface Props {
  bullet: Bullet;
  /** What the bullet was actually sent: its own text plus its inputs. */
  prompt: string | undefined;
  /** Undefined until this bullet has run — the modal opens either way. */
  result: string | undefined;
}

/**
 * One bullet's run, in three columns: what you wrote, what the model was
 * actually sent, and what came back. It is also how a bullet is opened at all
 * — clicking a node on the map or a bullet's dot in the outline opens this,
 * run or not, so the two right-hand columns are empty until there is a run.
 *
 * The middle column is the point of the thing. A bullet's prompt is not what
 * you typed — its children's answers are appended below it before it goes out —
 * so when a result is surprising, the question is almost always "what did it
 * actually see?", and until now that was unanswerable from the screen.
 *
 * The first column is the live bullet, not a copy of it: reading the three side
 * by side is exactly when you work out what the prompt should have said, and
 * having to close the modal to act on that is the wrong shape.
 */
export function ResultModal({ bullet, prompt, result }: Props) {
  const close = () => actions.openResult(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const titles = titleMap(getState());
  const vars = usePromptVarMap();
  const title = firstLine(bullet.text) || (bullet.kind === 'python' ? 'Python' : 'Untitled');

  return (
    <div className="res-modal" onClick={close} role="dialog" aria-modal="true">
      <div className="res-modal__panel" onClick={(e) => e.stopPropagation()}>
        <div className="res-modal__head">
          <h2 className="res-modal__title" title={title}>
            {title}
          </h2>
          <button className="res-modal__close" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="res-modal__cols">
          <section className="res-col">
            <h3 className="res-col__head">Your text</h3>
            {bullet.kind === 'python' ? (
              // A python bullet has no text of its own, and typing on one is
              // refused everywhere else — so it is not an editor here either.
              <p className="res-col__empty">{PYTHON_CAPTION}</p>
            ) : (
              <Editor bullet={bullet} titles={titles} />
            )}
          </section>

          <Column
            heading="Model input"
            body={prompt}
            titles={titles}
            vars={vars}
            empty="Not recorded — run this bullet again to capture it."
          />
          <Column
            heading="Model response"
            body={result}
            titles={titles}
            vars={vars}
            empty="Not run yet — press Run to fill this in."
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The bullet's own text, editable in place. Writes straight to the store, so
 * the outline and the map update behind the modal as you type — and the change
 * is saved the moment it is made, with nothing to confirm or discard.
 *
 * Mentions are shown in the same short-label form the outline uses, and
 * converted back to id tokens on the way in.
 */
function Editor({ bullet, titles }: { bullet: Bullet; titles: Record<string, string> }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const display = toDisplay(bullet.text, titles);

  // Grow to fit, so the whole prompt is visible without a nested scrollbar
  // until it is genuinely taller than the column.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [display]);

  return (
    <textarea
      ref={ref}
      className="res-col__edit"
      value={display}
      spellCheck={false}
      placeholder="Empty"
      onChange={(e) => actions.setText(bullet.id, displayToRaw(e.target.value, bullet.text, titles))}
    />
  );
}

function Column({
  heading,
  body,
  titles,
  vars,
  empty = 'Empty',
}: {
  heading: string;
  body: string | undefined;
  titles: Record<string, string>;
  vars: PromptVarMap;
  empty?: string;
}) {
  const text = (body ?? '').trim();
  return (
    <section className="res-col">
      <h3 className="res-col__head">{heading}</h3>
      {text ? (
        <div
          className="res-col__body"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(text, titles, vars) }}
        />
      ) : (
        <p className="res-col__empty">{empty}</p>
      )}
    </section>
  );
}
