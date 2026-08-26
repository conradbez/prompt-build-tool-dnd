/**
 * A small markdown → HTML renderer for bullet text.
 *
 * Deliberately tiny and dependency-free. Everything is HTML-escaped first and
 * only the tags below are ever emitted, so the output is safe to drop in with
 * `dangerouslySetInnerHTML`: headings, bold, italic, strikethrough, inline and
 * fenced code, links (http/https/mailto/relative only), lists, blockquotes.
 */

import { mentionLabel, type TitleMap } from './mentions';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Anything that isn't a plain document link is left as literal text. */
const SAFE_URL = /^(https?:\/\/|mailto:|\/|#)/i;

function inline(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, text, url) =>
      SAFE_URL.test(url)
        ? `<a href="${url}" target="_blank" rel="noreferrer noopener">${text}</a>`
        : whole,
    );
}

/** Turn already-escaped lines into block-level HTML. */
function blocks(lines: string[]): string {
  const out: string[] = [];
  let list: string[] | null = null;
  let fence: string[] | null = null;
  let para: string[] | null = null;

  const closeList = () => {
    if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = null;
  };
  const closePara = () => {
    if (para) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = null;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (fence) {
        out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
        fence = null;
      } else {
        closeList();
        closePara();
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      closePara();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const item = line.match(/^\s*[-*+]\s+(.*)$/);
    if (item) {
      closePara();
      (list ??= []).push(item[1]);
      continue;
    }

    const quote = line.match(/^\s*&gt;\s?(.*)$/);
    if (quote) {
      closeList();
      closePara();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    closeList();
    if (line.trim() === '') closePara();
    else (para ??= []).push(line);
  }

  if (fence) out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
  closeList();
  closePara();
  return out.join('');
}

/** Placeholder that markdown rules can't match, used to park mentions. */
const HOLD = '\u0002';
const tokenRe = () => /@\[\[([A-Za-z0-9_-]+)\]\]/g;

/**
 * Render a bullet's text. Mentions are lifted out first so that markdown rules
 * can't chew on an id (nanoid can contain `_`), then put back as coloured
 * spans carrying the target's full title for the hover tooltip.
 */
export function renderMarkdown(raw: string, titles: TitleMap): string {
  const ids: string[] = [];
  const held = raw.replace(tokenRe(), (_, id) => `${HOLD}${ids.push(id) - 1}${HOLD}`);
  const html = blocks(escapeHtml(held).split('\n'));
  return html.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_, i) => {
    const id = ids[Number(i)];
    const full = titles[id] || 'Untitled';
    return `<span class="md-mention" data-title="${escapeHtml(full)}">${escapeHtml(
      mentionLabel(titles[id]),
    )}</span>`;
  });
}
