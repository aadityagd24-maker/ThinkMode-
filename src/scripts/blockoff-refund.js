import { blockoffSupabase as supabase } from '../lib/blockoff/client.js';

const modal = document.querySelector('[data-refund-modal]');
const success = document.querySelector('[data-refund-success]');
const status = document.querySelector('[data-refund-status]');
const account = document.querySelector('[data-refund-account]');
const form = document.querySelector('[data-refund-form]');

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  return data.session ? { authorization: `Bearer ${data.session.access_token}` } : null;
}

async function openRefund() {
  const headers = await authHeaders();
  if (!headers) {
    window.location.href = `/blockoff/app?returnTo=${encodeURIComponent('/blockoff/returns')}`;
    return;
  }
  modal.hidden = false;
  account.textContent = 'Checking purchase eligibility...';
  try {
    const response = await fetch('/blockoff/api/refund.json', { headers });
    const data = await response.json();
    if (!response.ok || !data.eligible) throw new Error(data.error || 'No eligible active purchase was found for this account.');
    account.textContent = `${data.email} · ${data.plan} plan · eligible`;
    form.querySelector('button[type="submit"]').disabled = false;
  } catch (error) {
    account.textContent = error.message;
    form.querySelector('button[type="submit"]').disabled = true;
  }
}

document.querySelector('[data-open-refund]')?.addEventListener('click', openRefund);
document.querySelector('[data-close-refund]')?.addEventListener('click', () => { modal.hidden = true; });
document.querySelectorAll('[data-close-refund-success]').forEach((button) => button.addEventListener('click', () => { success.hidden = true; }));

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  const headers = await authHeaders();
  if (!headers) return openRefund();
  button.disabled = true;
  status.textContent = 'Submitting request...';
  try {
    const body = Object.fromEntries(new FormData(form));
    const response = await fetch('/blockoff/api/refund.json', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Could not submit your request.');
    form.reset();
    modal.hidden = true;
    success.hidden = false;
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});
