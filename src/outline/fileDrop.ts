import { useRef, useState } from 'react';
import { actions } from '../store';
import { filesEnabled, uploadFile } from '../api';

/** Asked once per page: whether the server has a bucket to put files in. */
let enabled: Promise<boolean> | null = null;
function canUpload(): Promise<boolean> {
  if (!enabled) enabled = filesEnabled();
  return enabled;
}

/** Only drags carrying files count — dragged text or links are left alone. */
function hasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

/** Upload files and attach each to the bullet, reporting failures in the run log. */
export async function attachFiles(id: string, files: File[]): Promise<void> {
  if (files.length === 0) return;
  try {
    if (!(await canUpload())) {
      throw new Error('Attachments are off: this server has no file bucket.');
    }
    for (const file of files) {
      actions.attachFile(id, await uploadFile(id, file));
    }
  } catch (err) {
    actions.setRunResult({}, [err instanceof Error ? err.message : String(err)]);
  }
}

/**
 * Drop files from the desktop onto an element to attach them to a bullet.
 * Bullet reordering uses pointer events, not HTML drag and drop, so the two
 * never meet. `over` is true while files hover the element, for a highlight.
 */
export function useFileDrop(id: string) {
  const [over, setOver] = useState(false);
  // dragenter/leave fire for every child crossed; count them to know when the
  // pointer has really left.
  const depth = useRef(0);

  const handlers = {
    onDragEnter(e: React.DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setOver(true);
    },
    onDragOver(e: React.DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave(e: React.DragEvent) {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop(e: React.DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setOver(false);
      void attachFiles(id, Array.from(e.dataTransfer.files));
    },
  };

  return { over, handlers };
}
