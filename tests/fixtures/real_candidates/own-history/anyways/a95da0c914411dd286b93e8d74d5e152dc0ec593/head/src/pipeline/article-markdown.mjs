const compact = value => String(value || '').replace(/\s+/g, ' ').trim();

function unwrapMarkdown(value) {
  const text = String(value || '').trim();
  const fenced = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return (fenced ? fenced[1] : text).trim();
}

function fallbackDek(candidate, body) {
  const supplied = compact(candidate.description).slice(0, 240);
  if (supplied) return supplied;
  const paragraph = body.split(/\n\s*\n/).map(compact).find(value => value && !value.startsWith('#')) || '';
  return paragraph.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 240) || 'A source-backed draft prepared for editorial review.';
}

export function parseArticleMarkdown(markdown, candidate = {}) {
  const raw = unwrapMarkdown(markdown);
  const lines = raw.split(/\r?\n/);
  const headingIndex = lines.findIndex(line => /^#\s+\S/.test(line));
  const headline = compact(headingIndex >= 0 ? lines[headingIndex].replace(/^#\s+/, '') : candidate.title).slice(0, 180) || 'Untitled article';
  if (headingIndex >= 0) lines.splice(headingIndex, 1);
  while (!lines[0]?.trim()) lines.shift();
  let dek = '';
  if (/^(?:\*[^*].*\*|_[^_].*_)$/.test(lines[0]?.trim() || '')) {
    dek = compact(lines.shift().trim().slice(1, -1)).slice(0, 300);
    while (!lines[0]?.trim()) lines.shift();
  }
  const body = lines.join('\n').trim() || raw;
  return {
    headline,
    dek: dek || fallbackDek(candidate, body),
    body,
    metadata: {
      supplied_heading: headingIndex >= 0,
      supplied_dek: Boolean(dek),
      looked_like_json: /^[{[]/.test(raw)
    }
  };
}
