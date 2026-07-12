import { ensureProfile, json, platformError, requireUser } from '../../../lib/blockoff/server.js';
import { buildAutoScanPlan, getScanSetting } from '../../../lib/blockoff/scan-policy.js';

export async function GET({ request }) {
  try {
    const auth = await requireUser(request, { requirePaid: true });
    if (auth.error) return auth.error;
    const { supabase, user } = auth;
    const profile = await ensureProfile(supabase, user);

    const [
      accounts,
      content,
      comments,
      activity,
      rules,
      subscription,
      quota,
    ] = await Promise.all([
      supabase.from('connected_accounts').select('id,platform,external_id,display_name,username,status,metadata,created_at,updated_at').eq('user_id', user.id).order('created_at', { ascending: false }),
      supabase.from('content_items').select('*').eq('user_id', user.id).order('published_at', { ascending: false }).limit(24),
      supabase.from('comments').select('*').eq('user_id', user.id).neq('status', 'allowed').order('priority_score', { ascending: false }).limit(50),
      supabase.from('activity_logs').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(20),
      supabase.from('rules').select('*').eq('user_id', user.id).order('created_at', { ascending: true }),
      supabase.from('subscriptions').select('*').eq('user_id', user.id).maybeSingle(),
      supabase.from('quota_usage').select('*').eq('user_id', user.id).gte('date', new Date().toISOString().slice(0, 10)).limit(10),
    ]);

    const allContent = content.data || [];
    const allRules = rules.data || [];
    const autoScanPlan = buildAutoScanPlan(allContent, allRules);

    return json({
      ok: true,
      user: { id: user.id, email: user.email },
      profile,
      accounts: accounts.data || [],
      content: allContent,
      comments: comments.data || [],
      activity: activity.data || [],
      rules: allRules,
      auto_scan: {
        enabled: getScanSetting(allRules, 'auto_scans_enabled', false),
        plan: autoScanPlan,
      },
      subscription: subscription.data || null,
      quota: quota.data || [],
    });
  } catch (error) {
    return platformError(error);
  }
}
