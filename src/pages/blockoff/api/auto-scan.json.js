import { buildAutoScanPlan } from '../../../lib/blockoff/scan-policy.js';
import { badRequest, json, logActivity, platformError, requireUser } from '../../../lib/blockoff/server.js';

export async function POST({ request }) {
  try {
    const auth = await requireUser(request, { requirePaid: true });
    if (auth.error) return auth.error;
    const { supabase, user } = auth;
    const body = await request.json().catch(() => null);
    if (typeof body?.enabled !== 'boolean') return badRequest('Choose whether auto scans are on or off.');

    const { error } = await supabase
      .from('rules')
      .upsert({
        user_id: user.id,
        type: 'system',
        value: 'auto_scans_enabled',
        action: 'configure',
        enabled: body.enabled,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,type,value' });

    if (error) throw error;

    const [{ data: rules }, { data: content }] = await Promise.all([
      supabase.from('rules').select('*').eq('user_id', user.id),
      supabase.from('content_items').select('*').eq('user_id', user.id).order('published_at', { ascending: false }).limit(100),
    ]);

    await logActivity(
      supabase,
      user.id,
      body.enabled ? 'Auto scans resumed' : 'Auto scans paused',
      body.enabled
        ? 'Continuous protection is active for new and high-activity content.'
        : 'No automated scans will run until you resume them.',
    );

    return json({
      ok: true,
      enabled: body.enabled,
      rules: rules || [],
      plan: buildAutoScanPlan(content || [], rules || []),
    });
  } catch (error) {
    return platformError(error);
  }
}
