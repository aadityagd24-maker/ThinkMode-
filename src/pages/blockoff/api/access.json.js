import { json, platformError, requireUser } from '../../../lib/blockoff/server.js';

const activeStatuses = new Set(['active', 'paid', 'trialing', 'manual']);
const ownerEmail = 'aadityagd24@gmail.com';
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '') || null;
const eventEmail = (event) => first(event?.data?.customer?.email, event?.data?.customer_email, event?.data?.billing?.email, event?.data?.email)?.toLowerCase();

async function reconcilePayment(supabase, user) {
  const events = await supabase.from('payment_webhook_events').select('*').eq('status', 'unmatched').order('created_at', { ascending: false }).limit(100);
  if (events.error) return null;
  const match = (events.data || []).find((row) => eventEmail(row.payload) === user.email?.toLowerCase() && ['payment.succeeded', 'subscription.active', 'subscription.renewed'].includes(row.event_type));
  if (!match) return null;
  const data = match.payload?.data || {};
  const subscription = {
    user_id: user.id,
    provider: 'dodo',
    provider_customer_id: first(data.customer_id, data.customer?.customer_id, data.customer?.id),
    provider_subscription_id: first(data.subscription_id, data.id?.startsWith?.('sub_') ? data.id : null),
    status: 'active',
    plan: 'founding',
    current_period_end: first(data.next_billing_date, data.current_period_end, data.expires_at),
    metadata: { ...data.metadata, reconciled_from_webhook: match.provider_event_id },
    updated_at: new Date().toISOString(),
  };
  const saved = await supabase.from('subscriptions').upsert(subscription, { onConflict: 'user_id,provider' }).select('*').single();
  if (!saved.error) await supabase.from('payment_webhook_events').update({ user_id: user.id, status: 'processed' }).eq('id', match.id);
  return saved.data || null;
}

export async function GET({ request }) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const isOwner = auth.user.email?.toLowerCase() === ownerEmail;
    let result = await auth.supabase.from('subscriptions').select('*').eq('user_id', auth.user.id).eq('provider', 'dodo').maybeSingle();
    let subscription = result.data || null;
    if (!isOwner && !subscription) subscription = await reconcilePayment(auth.supabase, auth.user);
    const eligible = isOwner || Boolean(subscription && activeStatuses.has(subscription.status));
    return json({ ok: true, eligible, is_owner: isOwner, subscription: subscription ? { status: subscription.status, plan: subscription.plan, current_period_end: subscription.current_period_end } : null });
  } catch (error) {
    return platformError(error);
  }
}
