import { Webhook } from 'standardwebhooks';
import { getSupabaseAdmin, json, serverEnv } from '../../../../lib/blockoff/server.js';

const activeEvents = new Set(['payment.succeeded', 'subscription.active', 'subscription.renewed']);
const inactiveEvents = new Set(['payment.failed', 'subscription.failed', 'subscription.expired']);
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '') || null;

export async function POST({ request }) {
  const secret = serverEnv('DODO_PAYMENTS_WEBHOOK_KEY');
  if (!secret) return json({ ok: false, error: 'Webhook is not configured.' }, { status: 503 });
  const raw = await request.text();
  const webhookId = request.headers.get('webhook-id');
  const signature = request.headers.get('webhook-signature');
  const timestamp = request.headers.get('webhook-timestamp');
  try {
    new Webhook(secret).verify(raw, { 'webhook-id': webhookId, 'webhook-signature': signature, 'webhook-timestamp': timestamp });
  } catch {
    return json({ ok: false, error: 'Invalid webhook signature.' }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  const existing = await supabase.from('payment_webhook_events').select('id').eq('provider_event_id', webhookId).maybeSingle();
  if (existing.data) return json({ received: true, duplicate: true });
  const event = JSON.parse(raw);
  const data = event.data || {};
  const subscriptionId = first(data.subscription_id, data.id?.startsWith?.('sub_') ? data.id : null);
  const customerId = first(data.customer_id, data.customer?.customer_id, data.customer?.id);
  const email = first(data.customer?.email, data.customer_email, data.billing?.email, data.email)?.toLowerCase();
  let userId = first(data.metadata?.user_id, data.metadata?.supabase_user_id);

  if (!userId && subscriptionId) {
    const match = await supabase.from('subscriptions').select('user_id').eq('provider_subscription_id', subscriptionId).maybeSingle();
    userId = match.data?.user_id || null;
  }
  if (!userId && customerId) {
    const match = await supabase.from('subscriptions').select('user_id').eq('provider_customer_id', customerId).maybeSingle();
    userId = match.data?.user_id || null;
  }
  if (!userId && email) {
    const match = await supabase.from('profiles').select('id').ilike('email', email).maybeSingle();
    userId = match.data?.id || null;
  }

  await supabase.from('payment_webhook_events').insert({ provider: 'dodo', provider_event_id: webhookId, event_type: event.type, user_id: userId, payload: event, status: userId ? 'processed' : 'unmatched' });
  if (!userId) return json({ received: true, matched: false });

  let status = data.status || 'active';
  if (activeEvents.has(event.type)) status = 'active';
  if (inactiveEvents.has(event.type)) status = event.type.includes('failed') ? 'failed' : 'expired';
  if (event.type === 'subscription.on_hold') status = 'on_hold';
  if (event.type === 'subscription.cancelled') status = 'cancelled';
  if (event.type === 'refund.succeeded') status = 'refunded';
  const saved = await supabase.from('subscriptions').upsert({
    user_id: userId,
    provider: 'dodo',
    provider_customer_id: customerId,
    provider_subscription_id: subscriptionId,
    status,
    plan: 'founding',
    current_period_end: first(data.next_billing_date, data.current_period_end, data.expires_at),
    metadata: { ...data.metadata, last_event: event.type, last_webhook_id: webhookId },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,provider' });
  if (saved.error) return json({ ok: false, error: 'Subscription sync failed.' }, { status: 500 });
  return json({ received: true, matched: true });
}
