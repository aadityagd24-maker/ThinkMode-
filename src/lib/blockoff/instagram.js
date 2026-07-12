import { decryptJson, encryptJson, serverEnv } from './server.js';

const apiVersion = import.meta.env.META_GRAPH_VERSION || 'v23.0';
const graphApi = `https://graph.instagram.com/${apiVersion}`;
const instagramTokenEndpoint = 'https://api.instagram.com/oauth/access_token';

async function responseJson(response, label) {
  const data = await response.json().catch(async () => ({ message: await response.text() }));
  if (!response.ok) {
    const message = data?.error?.message || data?.error_message || data?.message || response.statusText;
    throw new Error(`${label}: ${message}`);
  }
  return data;
}

export async function exchangeInstagramCode(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: serverEnv('META_APP_ID'),
    client_secret: serverEnv('META_APP_SECRET'),
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });

  const shortResponse = await fetch(instagramTokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const shortToken = await responseJson(shortResponse, 'Instagram token exchange failed');

  const longUrl = new URL('https://graph.instagram.com/access_token');
  longUrl.searchParams.set('grant_type', 'ig_exchange_token');
  longUrl.searchParams.set('client_secret', serverEnv('META_APP_SECRET'));
  longUrl.searchParams.set('access_token', shortToken.access_token);
  const longResponse = await fetch(longUrl);
  const longToken = await responseJson(longResponse, 'Instagram long-lived token exchange failed');
  const expiresIn = Number(longToken.expires_in || 5184000);

  return {
    ...shortToken,
    ...longToken,
    user_id: shortToken.user_id,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

export async function graphGet(path, accessToken, params = {}) {
  const url = new URL(`${graphApi}${path}`);
  url.searchParams.set('access_token', accessToken);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });

  return responseJson(await fetch(url), 'Instagram API failed');
}

export async function graphPost(path, accessToken, params = {}) {
  const url = new URL(`${graphApi}${path}`);
  url.searchParams.set('access_token', accessToken);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });

  return responseJson(await fetch(url, { method: 'POST' }), 'Instagram action failed');
}

export async function graphDelete(path, accessToken) {
  const url = new URL(`${graphApi}${path}`);
  url.searchParams.set('access_token', accessToken);
  return responseJson(await fetch(url, { method: 'DELETE' }), 'Instagram delete failed');
}

export async function getInstagramAccessToken(supabase, account) {
  const token = decryptJson(account.token_encrypted);
  if (!token.access_token) throw new Error('Instagram reconnect required.');

  const expiresAt = token.expires_at ? Date.parse(token.expires_at) : 0;
  const shouldRefresh = expiresAt && expiresAt < Date.now() + (7 * 86400000);
  if (!shouldRefresh) return token.access_token;

  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token.access_token);

  try {
    const refreshed = await responseJson(await fetch(url), 'Instagram token refresh failed');
    const updated = {
      ...token,
      ...refreshed,
      expires_at: new Date(Date.now() + Number(refreshed.expires_in || 5184000) * 1000).toISOString(),
    };
    await saveInstagramToken(supabase, account.id, updated);
    return updated.access_token;
  } catch (error) {
    if (!expiresAt || expiresAt <= Date.now()) {
      await supabase
        .from('connected_accounts')
        .update({ status: 'expired', updated_at: new Date().toISOString() })
        .eq('id', account.id);
      throw new Error('Instagram session expired. Reconnect the account.');
    }
    return token.access_token;
  }
}

export async function saveInstagramToken(supabase, accountId, token) {
  await supabase
    .from('connected_accounts')
    .update({ token_encrypted: encryptJson(token), status: 'active', updated_at: new Date().toISOString() })
    .eq('id', accountId);
}

export async function getInstagramBusinessAccount(accessToken) {
  const profile = await graphGet('/me', accessToken, {
    fields: 'id,user_id,username,name,account_type,profile_picture_url,media_count',
  });
  return profile?.id ? { ig: profile } : null;
}

export async function getInstagramMedia(accessToken, igUserId, limit = 12) {
  const data = await graphGet(`/${igUserId}/media`, accessToken, {
    fields: 'id,caption,media_type,media_url,thumbnail_url,timestamp,comments_count,like_count,permalink',
    limit: Math.min(limit, 50),
  });

  return data.data?.map((item) => ({
    platform: 'instagram',
    external_id: item.id,
    title: item.caption?.slice(0, 96) || `${item.media_type || 'Instagram'} post`,
    thumbnail_url: item.thumbnail_url || item.media_url || '',
    published_at: item.timestamp || null,
    comment_count: Number(item.comments_count || 0),
    view_count: 0,
    like_count: Number(item.like_count || 0),
    metadata: item,
  })) || [];
}

export async function getInstagramComments(accessToken, mediaId, limit = 25) {
  const data = await graphGet(`/${mediaId}/comments`, accessToken, {
    fields: 'id,text,from,username,timestamp,like_count,replies{id,text,from,username,timestamp,like_count}',
    limit: Math.min(limit, 100),
  });

  return data.data?.map((item, index) => ({
    platform: 'instagram',
    external_id: item.id,
    text: item.text || '',
    author_name: item.from?.username || item.username || 'Instagram user',
    author_channel_id: item.from?.id || item.username || null,
    like_count: Number(item.like_count || 0),
    reply_count: Number(item.replies?.data?.length || 0),
    published_at: item.timestamp || null,
    isTopComment: index < 3,
    raw: item,
  })) || [];
}

export async function hideInstagramComment(accessToken, commentId, hidden = true) {
  return graphPost(`/${commentId}`, accessToken, { hide: String(hidden) });
}

export async function deleteInstagramComment(accessToken, commentId) {
  return graphDelete(`/${commentId}`, accessToken);
}
