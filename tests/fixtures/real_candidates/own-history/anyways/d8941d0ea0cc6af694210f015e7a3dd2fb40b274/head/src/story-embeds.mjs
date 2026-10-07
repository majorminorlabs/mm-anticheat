const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be']);
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);

const cleanUrl = value => {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return null;
    return url;
  } catch {
    return null;
  }
};

const validYouTubeId = value => /^[A-Za-z0-9_-]{11}$/.test(String(value || ''));
const validPostId = value => /^\d{5,30}$/.test(String(value || ''));

function youtubeId(url) {
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return '';
  if (host === 'youtu.be' || host === 'www.youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
  if (url.pathname === '/watch') return url.searchParams.get('v') || '';
  const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/i);
  return match?.[1] || '';
}

function xPostId(url) {
  if (!X_HOSTS.has(url.hostname.toLowerCase())) return '';
  const match = url.pathname.match(/\/status\/(\d{5,30})(?:[/?#]|$)/i);
  return match?.[1] || '';
}

export function parseStoryEmbed(value) {
  const url = cleanUrl(value);
  if (!url) return null;

  const videoId = youtubeId(url);
  if (validYouTubeId(videoId)) {
    return {
      provider: 'youtube',
      id: videoId,
      sourceUrl: url.href,
      embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?rel=0`
    };
  }

  const postId = xPostId(url);
  if (validPostId(postId)) {
    return {
      provider: 'x',
      id: postId,
      sourceUrl: url.href,
      embedUrl: `https://platform.twitter.com/embed/Tweet.html?id=${encodeURIComponent(postId)}&dnt=true`
    };
  }

  return null;
}

export function storyEmbedFromValue(value = {}) {
  const parsed = parseStoryEmbed(value.source_url || value.embed_url || value.url);
  if (!parsed) return null;
  if (value.embed_provider && value.embed_provider !== parsed.provider) return null;
  return parsed;
}
