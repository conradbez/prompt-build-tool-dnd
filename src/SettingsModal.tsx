import { useEffect } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
}

/**
 * Run settings, in the same panel the answer modal uses: click-outside and
 * Escape close it, and what you type is saved as you type — there is nothing
 * to confirm, so the modal has no buttons of its own.
 *
 * One setting so far: the global instruction, which the server renders into
 * every prompt bullet's prompt (pbt's `global_instruction`).
 */
export function SettingsModal({ value, onChange, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="res-modal" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="res-modal__panel res-modal__panel--narrow"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="res-modal__head">
          <h2 className="res-modal__title">Settings</h2>
          <button className="res-modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="res-modal__cols">
          <section className="res-col">
            <h3 className="res-col__head">Global instruction prepended to every LLM call</h3>
            <textarea
              className="res-col__edit"
              value={value}
              autoFocus
              spellCheck={false}
              placeholder="e.g. Answer in British English, and keep it under 200 words."
              onChange={(e) => onChange(e.target.value)}
            />
            <p className="res-col__note">
              Template and python bullets are left alone — only prompts get it.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
