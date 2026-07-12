import { BLOCKOFF, getOAuthRedirectUri } from '../../../../../lib/blockoff/config.js';
import { json, platformError, randomState, requireUser, serverEnv } from '../../../../../lib/blockoff/server.js';

export async function POST({ request }) {
  try {
    const auth = await requireUser(request, { requirePaid: true });
    if (auth.error) return auth.error;
    const { supabase, user } = auth;
    const state = randomState();
    const redirectUri = getOAuthRedirectUri('youtube', request.url);
    const clientId = serverEnv('YOUTUBE_CLIENT_ID');
    if (!clientId) throw new Error('YouTube connection is not configured: YOUTUBE_CLIENT_ID is missing.');

    await supabase.from('oauth_states').insert({
      user_id: user.id,
      platform: 'youtube',
      state,
      redirect_uri: redirectUri,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('scope', BLOCKOFF.youtubeScope);
    url.searchParams.set('state', state);

    return json({ ok: true, url: url.toString() });
  } catch (error) {
    return platformError(error);
  }
}
