import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.PUBLIC_BLOCKOFF_SUPABASE_URL;
const serviceRoleKey = import.meta.env.BLOCKOFF_SUPABASE_SERVICE_ROLE_KEY;

const bundledServerEnv = {
  YOUTUBE_CLIENT_ID: import.meta.env.YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET: import.meta.env.YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REDIRECT_URI: import.meta.env.YOUTUBE_REDIRECT_URI,
  META_APP_ID: import.meta.env.META_APP_ID,
  META_APP_SECRET: import.meta.env.META_APP_SECRET,
  META_REDIRECT_URI: import.meta.env.META_REDIRECT_URI,
  INSTAGRAM_REDIRECT_URI: import.meta.env.INSTAGRAM_REDIRECT_URI,
  OPENAI_API_KEY: import.meta.env.OPENAI_API_KEY,
  BLOCKOFF_AI_BASE_URL: import.meta.env.BLOCKOFF_AI_BASE_URL,
  BLOCKOFF_AI_DAILY_CAP: import.meta.env.BLOCKOFF_AI_DAILY_CAP,
  BLOCKOFF_AI_MODEL: import.meta.env.BLOCKOFF_AI_MODEL,
  BLOCKOFF_AI_FALLBACK_MODEL: import.meta.env.BLOCKOFF_AI_FALLBACK_MODEL,
  DODO_PAYMENTS_WEBHOOK_KEY: import.meta.env.DODO_PAYMENTS_WEBHOOK_KEY,
};

export function serverEnv(name) {
  return String(process.env[name] || bundledServerEnv[name] || '').trim();
}

export function getSupabaseAdmin() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing Block OFF Supabase server environment variables.');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}

export function badRequest(message, extra = {}) {
  return json({ ok: false, error: message, ...extra }, { status: 400 });
}

export function unauthorized(message = 'Login required.') {
  return json({ ok: false, error: message }, { status: 401 });
}

export async function requireUser(request, options = {}) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: unauthorized() };

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return { error: unauthorized('Your session expired. Please log in again.') };

  if (options.requirePaid && data.user.email?.toLowerCase() !== 'aadityagd24@gmail.com') {
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('status')
      .eq('user_id', data.user.id)
      .eq('provider', 'dodo')
      .maybeSingle();
    if (!subscription || !['active', 'paid', 'trialing', 'manual'].includes(subscription.status)) {
      return { error: json({ ok: false, error: 'Paid Block OFF membership required.', code: 'subscription_required' }, { status: 402 }) };
    }
  }
  return { supabase, user: data.user };
}

export async function ensureProfile(supabase, user) {
  const email = user.email || null;
  const fullName = user.user_metadata?.full_name || user.user_metadata?.name || null;

  await supabase
    .from('profiles')
    .upsert({
      id: user.id,
      email,
      full_name: fullName,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  return data;
}

export function randomState() {
  return crypto.randomBytes(24).toString('base64url');
}

function encryptionKey() {
  const raw = import.meta.env.TOKEN_ENCRYPTION_KEY || '';
  if (!raw) throw new Error('Missing TOKEN_ENCRYPTION_KEY.');
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

export function decryptJson(payload) {
  const buffer = Buffer.from(payload, 'base64url');
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

export async function logActivity(supabase, userId, title, detail, platform = null) {
  await supabase.from('activity_logs').insert({
    user_id: userId,
    platform,
    title,
    detail,
  });
}

export function platformError(error) {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : error?.message || error?.error_description || error?.details || JSON.stringify(error);
  return json({ ok: false, error: message }, { status: 500 });
}
