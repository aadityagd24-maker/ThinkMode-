import { decryptJson, encryptJson, serverEnv } from './server.js';

const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const youtubeApi = 'https://www.googleapis.com/youtube/v3';

export class YoutubeApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'YoutubeApiError';
    this.reason = details.reason || null;
    this.status = details.status || null;
    this.details = details;
  }
}

export async function exchangeYoutubeCode(code, redirectUri) {
  const body = new URLSearchParams({
    code,
    client_id: serverEnv('YOUTUBE_CLIENT_ID'),
    client_secret: serverEnv('YOUTUBE_CLIENT_SECRET'),
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    throw new Error(`YouTube token exchange failed: ${await response.text()}`);
  }

  return response.json();
}

export async function refreshYoutubeToken(supabase, account) {
  const token = decryptJson(account.token_encrypted);
  if (token.access_token && token.expires_at && Date.parse(token.expires_at) > Date.now() + 60000) {
    return token.access_token;
  }

  if (!token.refresh_token) throw new Error('YouTube reconnect required.');

  const body = new URLSearchParams({
    client_id: serverEnv('YOUTUBE_CLIENT_ID'),
    client_secret: serverEnv('YOUTUBE_CLIENT_SECRET'),
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    throw new Error(`YouTube refresh failed: ${await response.text()}`);
  }

  const next = await response.json();
  const updated = {
    ...token,
    ...next,
    refresh_token: next.refresh_token || token.refresh_token,
    expires_at: new Date(Date.now() + Number(next.expires_in || 3600) * 1000).toISOString(),
  };

  await supabase
    .from('connected_accounts')
    .update({ token_encrypted: encryptJson(updated), status: 'active', updated_at: new Date().toISOString() })
    .eq('id', account.id);

  return updated.access_token;
}

export async function youtubeGet(path, accessToken, params = {}) {
  const url = new URL(`${youtubeApi}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const text = await response.text();
    let details = {};
    try {
      const payload = JSON.parse(text);
      const first = payload.error?.errors?.[0] || {};
      details = {
        status: payload.error?.code || response.status,
        reason: first.reason || payload.error?.status || null,
        message: payload.error?.message || text,
        raw: payload,
      };
    } catch {
      details = { status: response.status, message: text };
    }
    throw new YoutubeApiError(details.message || 'YouTube API failed.', details);
  }

  return response.json();
}

export async function youtubePost(path, accessToken, params = {}) {
  const url = new URL(`${youtubeApi}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try { message = JSON.parse(text)?.error?.message || text; } catch { /* Keep raw provider response. */ }
    throw new Error(`YouTube action failed: ${message}`);
  }

  return response;
}

export async function getYoutubeChannel(accessToken) {
  const data = await youtubeGet('/channels', accessToken, {
    part: 'snippet,contentDetails,statistics',
    mine: 'true',
  });
  return data.items?.[0] || null;
}

export async function getYoutubeVideos(accessToken, limit = 12) {
  const channel = await getYoutubeChannel(accessToken);
  if (!channel) return { channel: null, videos: [] };

  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return { channel, videos: [] };

  const playlist = await youtubeGet('/playlistItems', accessToken, {
    part: 'snippet,contentDetails',
    playlistId: uploads,
    maxResults: Math.min(limit, 50),
  });

  const ids = playlist.items?.map((item) => item.contentDetails?.videoId).filter(Boolean) || [];
  if (!ids.length) return { channel, videos: [] };

  const details = await youtubeGet('/videos', accessToken, {
    part: 'snippet,statistics',
    id: ids.join(','),
    maxResults: ids.length,
  });

  const videos = details.items?.map((item) => ({
    platform: 'youtube',
    external_id: item.id,
    title: item.snippet?.title || 'Untitled video',
    thumbnail_url: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
    published_at: item.snippet?.publishedAt || null,
    comment_count: Number(item.statistics?.commentCount || 0),
    view_count: Number(item.statistics?.viewCount || 0),
    like_count: Number(item.statistics?.likeCount || 0),
    metadata: item,
  })) || [];

  return { channel, videos };
}

export async function getYoutubeComments(accessToken, videoId, maxResults = 25) {
  const data = await youtubeGet('/commentThreads', accessToken, {
    part: 'snippet,replies',
    videoId,
    order: 'relevance',
    textFormat: 'plainText',
    maxResults: Math.min(maxResults, 100),
  });

  return data.items?.map((item, index) => {
    const top = item.snippet?.topLevelComment;
    const snippet = top?.snippet || {};
    return {
      platform: 'youtube',
      external_id: top?.id || item.id,
      text: snippet.textDisplay || snippet.textOriginal || '',
      author_name: snippet.authorDisplayName || 'YouTube user',
      author_channel_id: snippet.authorChannelId?.value || null,
      like_count: Number(snippet.likeCount || 0),
      reply_count: Number(item.snippet?.totalReplyCount || 0),
      published_at: snippet.publishedAt || null,
      isTopComment: index < 3,
      raw: item,
    };
  }) || [];
}

export async function moderateYoutubeComments(accessToken, ids, action) {
  if (!ids.length) return;
  const moderationStatus = action === 'restore' || action === 'allow' ? 'published' : 'rejected';
  const banAuthor = action === 'blockoff' ? 'true' : undefined;

  await youtubePost('/comments/setModerationStatus', accessToken, {
    id: ids.join(','),
    moderationStatus,
    banAuthor,
  });
}
