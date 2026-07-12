import { exchangeYoutubeCode, getYoutubeChannel } from '../../../../lib/blockoff/youtube.js';
import { encryptJson, getSupabaseAdmin, logActivity } from '../../../../lib/blockoff/server.js';

export async function GET({ request, redirect }) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) return redirect('/blockoff/app?error=youtube_oauth_missing');

  const supabase = getSupabaseAdmin();
  const { data: stateRow } = await supabase
    .from('oauth_states')
    .select('*')
    .eq('platform', 'youtube')
    .eq('state', state)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (!stateRow) return redirect('/blockoff/app?error=youtube_oauth_expired');

  try {
    const token = await exchangeYoutubeCode(code, stateRow.redirect_uri);
    const tokenPayload = {
      ...token,
      expires_at: new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString(),
    };
    const channel = await getYoutubeChannel(token.access_token);

    await supabase.from('connected_accounts').upsert({
      user_id: stateRow.user_id,
      platform: 'youtube',
      external_id: channel?.id || 'youtube-channel',
      display_name: channel?.snippet?.title || 'YouTube channel',
      username: channel?.snippet?.customUrl || null,
      status: 'active',
      token_encrypted: encryptJson(tokenPayload),
      metadata: channel || {},
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,platform,external_id' });

    await supabase.from('oauth_states').delete().eq('id', stateRow.id);
    await logActivity(supabase, stateRow.user_id, 'YouTube connected', channel?.snippet?.title || 'Channel connected', 'youtube');

    return redirect('/blockoff/app?connected=youtube');
  } catch (error) {
    await supabase.from('oauth_states').delete().eq('id', stateRow.id);
    return redirect(`/blockoff/app?error=${encodeURIComponent(error.message || 'youtube_connect_failed')}`);
  }
}
