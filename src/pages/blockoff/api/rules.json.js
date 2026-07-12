import { badRequest, json, logActivity, platformError, requireUser } from '../../../lib/blockoff/server.js';

const allowedRules = new Set([
  'scam_links',
  'engagement_priority',
  'constructive_shield',
  'brand_risk',
]);

export async function POST({ request }) {
  try {
    const auth = await requireUser(request, { requirePaid: true });
    if (auth.error) return auth.error;
    const { supabase, user } = auth;
    const body = await request.json().catch(() => null);
    const key = String(body?.key || '');

    if (!allowedRules.has(key) || typeof body?.enabled !== 'boolean') {
      return badRequest('Invalid moderation rule.');
    }

    const { error } = await supabase
      .from('rules')
      .upsert({
        user_id: user.id,
        type: 'system',
        value: key,
        action: 'configure',
        enabled: body.enabled,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,type,value' });

    if (error) throw error;

    const { data: rules, error: readError } = await supabase
      .from('rules')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });

    if (readError) throw readError;

    await logActivity(
      supabase,
      user.id,
      'Moderation rule updated',
      `${key.replaceAll('_', ' ')} ${body.enabled ? 'enabled' : 'disabled'}`,
    );

    return json({ ok: true, rules: rules || [] });
  } catch (error) {
    return platformError(error);
  }
}
