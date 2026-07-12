import { badRequest, json, platformError, requireUser } from '../../../lib/blockoff/server.js';

const eligibleStatuses = new Set(['active', 'paid', 'trialing', 'manual']);

async function getSubscription(supabase, userId) {
  const result = await supabase.from('subscriptions').select('*').eq('user_id', userId).eq('provider', 'dodo').maybeSingle();
  if (result.error) throw result.error;
  return result.data;
}

export async function GET({ request }) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const subscription = await getSubscription(auth.supabase, auth.user.id);
    const eligible = Boolean(subscription && eligibleStatuses.has(subscription.status));
    return json({ ok: true, eligible, email: auth.user.email, plan: subscription?.plan || null, error: eligible ? null : 'No eligible active purchase was found for this account.' });
  } catch (error) { return platformError(error); }
}

export async function POST({ request }) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const subscription = await getSubscription(auth.supabase, auth.user.id);
    if (!subscription || !eligibleStatuses.has(subscription.status)) return json({ ok: false, error: 'No eligible active purchase was found for this account.' }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const reason = String(body.reason || '').trim();
    const experience = String(body.experience || '').trim().slice(0, 2000);
    if (!reason) return badRequest('Choose a reason for leaving.');
    const existing = await auth.supabase.from('refund_requests').select('id,status').eq('user_id', auth.user.id).in('status', ['submitted', 'reviewing']).maybeSingle();
    if (existing.data) return json({ ok: false, error: 'A refund request is already being reviewed.' }, { status: 409 });
    const inserted = await auth.supabase.from('refund_requests').insert({ user_id: auth.user.id, subscription_id: subscription.id, provider: 'dodo', reason, experience, status: 'submitted' }).select('id').single();
    if (inserted.error) throw inserted.error;
    return json({ ok: true, request_id: inserted.data.id });
  } catch (error) { return platformError(error); }
}
