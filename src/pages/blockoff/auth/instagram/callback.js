import { exchangeInstagramCode, getInstagramBusinessAccount } from '../../../../lib/blockoff/instagram.js';
import { encryptJson, getSupabaseAdmin, logActivity } from '../../../../lib/blockoff/server.js';

export async function GET({ request, redirect }) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) return redirect('/blockoff/app?error=instagram_oauth_missing');

  const supabase = getSupabaseAdmin();
  const { data: stateRow } = await supabase
    .from('oauth_states')
    .select('*')
    .eq('platform', 'instagram')
    .eq('state', state)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (!stateRow) return redirect('/blockoff/app?error=instagram_oauth_expired');

  try {
    const token = await exchangeInstagramCode(code, stateRow.redirect_uri);
    const business = await getInstagramBusinessAccount(token.access_token);

    if (!business?.ig) {
      throw new Error('No Instagram Business or Creator account was returned. Confirm the account is Professional, then reconnect.');
    }

    await supabase.from('connected_accounts').upsert({
      user_id: stateRow.user_id,
      platform: 'instagram',
      external_id: business.ig.id,
      display_name: business.ig.name || business.ig.username || 'Instagram account',
      username: business.ig.username || null,
      status: 'active',
      token_encrypted: encryptJson(token),
      metadata: business,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,platform,external_id' });

    await supabase.from('oauth_states').delete().eq('id', stateRow.id);
    await logActivity(supabase, stateRow.user_id, 'Instagram connected', business.ig.username || 'Business account connected', 'instagram');

    return redirect('/blockoff/app?connected=instagram');
  } catch (error) {
    await supabase.from('oauth_states').delete().eq('id', stateRow.id);
    return redirect(`/blockoff/app?error=${encodeURIComponent(error.message || 'instagram_connect_failed')}`);
  }
}
