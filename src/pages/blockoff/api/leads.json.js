import { badRequest, getSupabaseAdmin, json, platformError } from '../../../lib/blockoff/server.js';

export async function POST({ request }) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) return badRequest('Invalid form submission.');
    const type = body.type === 'vip_application' ? 'vip_application' : 'purchase_intent';
    const name = String(body.name || '').trim().slice(0, 120);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 240);
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return badRequest('Enter your name and a valid email.');

    const details = type === 'vip_application'
      ? {
          youtube: String(body.youtube_handle || '').trim().slice(0, 120),
          youtube_followers: Math.max(0, Number(body.youtube_followers || 0)),
          instagram: String(body.instagram_handle || '').trim().slice(0, 120),
          instagram_followers: Math.max(0, Number(body.instagram_followers || 0)),
          note: String(body.creator_note || '').trim().slice(0, 500),
        }
      : {
          youtube: String(body.youtube_handle || '').trim().slice(0, 120),
          instagram: String(body.instagram_handle || '').trim().slice(0, 120),
        };

    if (type === 'vip_application' && details.youtube_followers < 100000 && details.instagram_followers < 300000) {
      return badRequest('VIP access requires 100,000+ YouTube subscribers or 300,000+ Instagram followers.');
    }

    const supabase = getSupabaseAdmin();
    const row = {
      name,
      email,
      social_handle: JSON.stringify(details),
      intent: type,
      source_page: '/blockoff',
      user_agent: String(request.headers.get('user-agent') || '').slice(0, 500),
    };
    const existing = await supabase.from('waitlist_signups').select('id').eq('email', email).maybeSingle();
    const result = existing.data
      ? await supabase.from('waitlist_signups').update(row).eq('id', existing.data.id)
      : await supabase.from('waitlist_signups').insert(row);
    if (result.error) throw result.error;
    return json({ ok: true, type });
  } catch (error) {
    return platformError(error);
  }
}
