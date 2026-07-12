import { demoContent } from '../../../lib/blockoff/moderation.js';
import { getInstagramAccessToken, getInstagramBusinessAccount, getInstagramMedia } from '../../../lib/blockoff/instagram.js';
import { getYoutubeVideos, refreshYoutubeToken } from '../../../lib/blockoff/youtube.js';
import { json, logActivity, platformError, requireUser } from '../../../lib/blockoff/server.js';

function scoreFromComments(comments = []) {
  if (!comments.length) return 0;
  return Math.max(...comments.map((comment) => Number(comment.priority_score || 0)));
}

async function upsertContent(supabase, userId, rows) {
  if (!rows.length) return [];
  const payload = rows.map((row) => ({
    user_id: userId,
    platform: row.platform,
    external_id: row.external_id,
    title: row.title,
    thumbnail_url: row.thumbnail_url,
    published_at: row.published_at,
    comment_count: row.comment_count,
    view_count: row.view_count,
    like_count: row.like_count || 0,
    metadata: row.metadata || {},
    updated_at: new Date().toISOString(),
  }));

  const { data, error } = await supabase
    .from('content_items')
    .upsert(payload, { onConflict: 'user_id,platform,external_id' })
    .select('*');

  if (error) throw error;
  return data || [];
}

export async function GET({ request }) {
  try {
    const auth = await requireUser(request, { requirePaid: true });
    if (auth.error) return auth.error;
    const { supabase, user } = auth;
    const url = new URL(request.url);
    const platform = url.searchParams.get('platform') === 'instagram' ? 'instagram' : 'youtube';
    const refresh = url.searchParams.get('refresh') === '1';

    const { data: account } = await supabase
      .from('connected_accounts')
      .select('*')
      .eq('user_id', user.id)
      .eq('platform', platform)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!account) {
      return json({ ok: true, connected: false, content: demoContent(platform), demo: true });
    }

    const { data: cachedRows, error: cachedError } = await supabase
      .from('content_items')
      .select('*')
      .eq('user_id', user.id)
      .eq('platform', platform)
      .order('published_at', { ascending: false })
      .limit(24);

    if (cachedError) throw cachedError;

    let rows = cachedRows || [];
    if (refresh || !rows.length) {
      if (platform === 'youtube') {
        const token = await refreshYoutubeToken(supabase, account);
        const { videos } = await getYoutubeVideos(token, 16);
        rows = await upsertContent(supabase, user.id, videos);
        await logActivity(supabase, user.id, 'YouTube videos refreshed', `${rows.length} videos loaded`, 'youtube');
      } else {
        const token = await getInstagramAccessToken(supabase, account);
        const business = await getInstagramBusinessAccount(token);
        const media = business?.ig ? await getInstagramMedia(token, business.ig.id, 16) : [];
        rows = await upsertContent(supabase, user.id, media);
        await logActivity(supabase, user.id, 'Instagram posts refreshed', `${rows.length} posts loaded`, 'instagram');
      }
    }

    const ids = rows.map((row) => row.id);
    const { data: comments } = ids.length
      ? await supabase
        .from('comments')
        .select('*')
        .eq('user_id', user.id)
        .in('content_item_id', ids)
        .order('priority_score', { ascending: false })
        .limit(240)
      : { data: [] };

    const enriched = rows.map((row) => {
      const top = (comments || []).filter((comment) => comment.content_item_id === row.id).slice(0, 10);
      return { ...row, risk_score: scoreFromComments(top), top_comments: top };
    });

    return json({ ok: true, connected: true, content: enriched, demo: false, refreshed: refresh || !cachedRows?.length });
  } catch (error) {
    return platformError(error);
  }
}
