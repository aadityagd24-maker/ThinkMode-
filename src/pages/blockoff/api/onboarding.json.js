import { badRequest, json, logActivity, platformError, requireUser } from '../../../lib/blockoff/server.js';

export async function POST({ request }) {
  try {
    const auth = await requireUser(request, { requirePaid: true });
    if (auth.error) return auth.error;
    const { supabase, user } = auth;
    const body = await request.json().catch(() => null);
    if (!body) return badRequest('Invalid onboarding payload.');

    const mode = body.mode === 'brand' ? 'brand' : 'creator';
    const protectionMode = body.protection_mode === 'auto_high_confidence' ? 'auto_high_confidence' : 'review_first';
    const brandNames = Array.isArray(body.brand_names) ? body.brand_names.filter(Boolean).slice(0, 12) : [];
    const keywords = Array.isArray(body.keywords) ? body.keywords.filter(Boolean).slice(0, 30) : [];

    const { data, error } = await supabase
      .from('profiles')
      .update({
        account_type: mode,
        protection_mode: protectionMode,
        brand_names: brandNames,
        sensitive_keywords: keywords,
        onboarding_completed: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)
      .select('*')
      .single();

    if (error) throw error;

    const ruleRows = keywords.map((keyword) => ({
      user_id: user.id,
      type: 'keyword',
      value: keyword.toLowerCase(),
      action: 'review',
      enabled: true,
    }));

    const { error: deleteRulesError } = await supabase
      .from('rules')
      .delete()
      .eq('user_id', user.id)
      .eq('type', 'keyword');

    if (deleteRulesError) throw deleteRulesError;

    if (ruleRows.length) {
      const { error: rulesError } = await supabase
        .from('rules')
        .upsert(ruleRows, { onConflict: 'user_id,type,value' });
      if (rulesError) throw rulesError;
    }

    await logActivity(supabase, user.id, 'Workspace personalized', `${mode === 'brand' ? 'Brand' : 'Creator'} mode with ${protectionMode.replaceAll('_', ' ')} protection`);

    return json({ ok: true, profile: data });
  } catch (error) {
    return platformError(error);
  }
}
