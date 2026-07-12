import { json, platformError, requireUser } from '../../../../lib/blockoff/server.js';

export async function GET({ request }) {
  try {
    const auth = await requireUser(request, { requirePaid: true });
    if (auth.error) return auth.error;
    const { supabase, user } = auth;
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim();
    const platform = url.searchParams.get('platform');

    let query = supabase
      .from('comments')
      .select('*')
      .eq('user_id', user.id)
      .order('priority_score', { ascending: false })
      .limit(80);

    if (platform === 'youtube' || platform === 'instagram') query = query.eq('platform', platform);
    if (q) query = query.ilike('text', `%${q}%`);

    const { data, error } = await query;
    if (error) throw error;

    return json({ ok: true, comments: data || [] });
  } catch (error) {
    return platformError(error);
  }
}
