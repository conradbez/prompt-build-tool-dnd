/**
 * A small markdown → HTML renderer for bullet text.
 *
 * Deliberately tiny and dependency-free. Everything is HTML-escaped first and
 * only the tags below are ever emitted, so the output is safe to drop in with
 * `dangerouslySetInnerHTML`: headings, bold, italic, strikethrough, inline and
 * fenced code, links (http/https/mailto/relative only), lists, blockquotes,
 * and GFM pipe tables — models reach for a table the moment you ask them to
 * score anything, so a run's output is full of them.
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

/** A `| a | b |` row. */
const TABLE_ROW = /^\s*\|.*\|\s*$/;
/** The `|---|:--:|` rule under a header, which is what makes it a table. */
const TABLE_RULE = /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

/** Column alignments from the rule row: `:--` left, `--:` right, `:-:` centre. */
function alignments(rule: string): string[] {
  return cells(rule).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return ' style="text-align:center"';
    if (right) return ' style="text-align:right"';
    return '';
  });
}

function table(header: string, rule: string, body: string[]): string {
  const align = alignments(rule);
  const cell = (tag: string, row: string[]) =>
    row.map((c, i) => `<${tag}${align[i] ?? ''}>${inline(c)}</${tag}>`).join('');
  const rows = body.map((r) => `<tr>${cell('td', cells(r))}</tr>`).join('');
  // Wrapped: a table is regularly wider than the column it lands in, and the
  // scrollbar has to belong to the table rather than to the page around it.
  return (
    `<div class="md-table"><table><thead><tr>${cell('th', cells(header))}</tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      closeList();
      closePara();
      const body: string[] = [];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j])) body.push(lines[j++]);
      out.push(table(line, lines[i + 1], body));
      i = j - 1;
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

/**
 * Render *only* the inline marks — bold, italic, code, links, mentions.
 *
 * For the outline's one-line answer preview, where block structure is the
 * enemy: a heading or a table crammed into a 20px box reads as a wall, but the
 * emphasis a model puts on the actual answer is worth keeping. Whitespace is
 * flattened first so a multi-paragraph reply arrives as one continuous phrase.
 */
export function renderInlineMarkdown(raw: string, titles: TitleMap): string {
  const ids: string[] = [];
  const held = raw.replace(tokenRe(), (_, id) => `${HOLD}${ids.push(id) - 1}${HOLD}`);
  const flat = escapeHtml(held).replace(/\s+/g, ' ').trim();
  return inline(flat).replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_, i) => {
    const id = ids[Number(i)];
    const full = titles[id] || 'Untitled';
    return `<span class="md-mention" data-title="${escapeHtml(full)}">${escapeHtml(
      mentionLabel(titles[id]),
    )}</span>`;
  });
}
