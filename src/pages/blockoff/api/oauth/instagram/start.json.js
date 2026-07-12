import { BLOCKOFF, getOAuthRedirectUri } from '../../../../../lib/blockoff/config.js';
import { json, platformError, randomState, requireUser, serverEnv } from '../../../../../lib/blockoff/server.js';

export async function POST({ request }) {
  try {
    const auth = await requireUser(request, { requirePaid: true });
    if (auth.error) return auth.error;
    const { supabase, user } = auth;
    const state = randomState();
    const redirectUri = getOAuthRedirectUri('instagram', request.url);
    const clientId = serverEnv('META_APP_ID');
    if (!clientId) throw new Error('Instagram connection is not configured: META_APP_ID is missing.');

    await supabase.from('oauth_states').insert({
      user_id: user.id,
      platform: 'instagram',
      state,
      redirect_uri: redirectUri,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', BLOCKOFF.instagramScopes.join(','));
    url.searchParams.set('state', state);
    url.searchParams.set('force_reauth', 'true');
    url.searchParams.set('enable_fb_login', '0');

    return json({ ok: true, url: url.toString() });
  } catch (error) {
    return platformError(error);
  }
}
