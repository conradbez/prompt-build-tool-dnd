import { useState } from 'react';
import { fileLink } from './api';
import type { RunFile } from './types';

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const isImage = (f: RunFile) => f.mime.startsWith('image/') && !!f.url;

/**
 * The files a bullet produced, in the outline's answer column: a thumbnail or
 * two, so a run that made images shows it at a glance. The whole strip opens
 * the bullet, where the files are shown in full.
 */
export function FileThumbs({ files, onOpen }: { files: RunFile[]; onOpen: () => void }) {
  const shown = files.slice(0, 3);
  return (
    <button
      type="button"
      className="rf-thumbs"
      title={files.map((f) => f.name).join(', ')}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onOpen}
    >
      {shown.map((f) =>
        isImage(f) ? (
          <img key={f.name} className="rf-thumbs__img" src={f.url} alt={f.name} />
        ) : (
          <span key={f.name} className="rf-thumbs__doc">
            📄
          </span>
        ),
      )}
      {files.length > shown.length && <span className="rf-thumbs__more">+{files.length - shown.length}</span>}
    </button>
  );
}

/**
 * The files in the bullet's window, under its answer: images shown, every
 * file downloadable. A file too large to send with the run is fetched from the
 * bucket on click; without a bucket it is listed by name — it still reached
 * the bullets downstream.
 */
export function FileGallery({ files }: { files: RunFile[] }) {
  return (
    <div className="rf-gallery">
      <h4 className="rf-gallery__head">
        {files.length} file{files.length === 1 ? '' : 's'}
      </h4>
      {files.map((f) => (
        <figure key={f.name} className="rf-file">
          {isImage(f) && <img className="rf-file__img" src={f.url} alt={f.name} />}
          <figcaption className="rf-file__cap">
            <span className="rf-file__name">{f.name}</span>
            <span className="rf-file__size">{size(f.size)}</span>
            {f.url ? (
              <a className="rf-file__dl" href={f.url} download={f.name}>
                Download
              </a>
            ) : f.key ? (
              <StoredDownload name={f.name} storeKey={f.key} />
            ) : (
              <span className="rf-file__size">too large to download</span>
            )}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/**
 * Download for a file kept in the bucket: the link is signed on click, since
 * it only lasts a few minutes, and the browser saves it under its own name.
 */
function StoredDownload({ name, storeKey }: { name: string; storeKey: string }) {
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});
  return (
    <>
      <button
        type="button"
        className="rf-file__dl"
        disabled={state.busy}
        onClick={async () => {
          setState({ busy: true });
          try {
            window.location.href = await fileLink({ key: storeKey, name });
            setState({});
          } catch (e) {
            setState({ error: (e as Error).message });
          }
        }}
      >
        {state.busy ? 'Preparing…' : 'Download'}
      </button>
      {state.error && <span className="rf-file__size">{state.error}</span>}
    </>
  );
}
