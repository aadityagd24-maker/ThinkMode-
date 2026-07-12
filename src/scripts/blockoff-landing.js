import { blockoffSupabase as supabase } from '../lib/blockoff/client.js';

const checkoutUrl = 'https://checkout.dodopayments.com/buy/pdt_0NifiEEyfRrWecyWA1Zvb?quantity=1';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function setModal(modal, open) {
  if (!modal) return;
  modal.hidden = !open;
  document.body.style.overflow = open ? 'hidden' : '';
  if (open) modal.querySelector('input')?.focus();
}

async function accessHeaders() {
  const { data } = await supabase.auth.getSession();
  return data.session ? { authorization: `Bearer ${data.session.access_token}` } : null;
}

async function updateMemberCtas() {
  const headers = await accessHeaders();
  if (!headers) return;
  try {
    const response = await fetch('/blockoff/api/access.json', { headers });
    const access = await response.json();
    if (!response.ok || !access.eligible) return;
    $$('[data-member-route]').forEach((link) => { link.href = '/blockoff/app'; link.textContent = 'Open app'; });
    $('[data-open-purchase]')?.setAttribute('hidden', '');
    $('[data-member-only]')?.removeAttribute('hidden');
  } catch { /* Keep public CTAs when membership cannot be checked. */ }
}

async function submitLead(form, type, statusElement) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  statusElement.textContent = type === 'vip_application' ? 'Sending application...' : 'Saving your details...';
  try {
    const payload = { type, ...Object.fromEntries(new FormData(form)) };
    const response = await fetch('/blockoff/api/leads.json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || 'Could not save your details.');
    form.reset();
    return true;
  } catch (error) {
    statusElement.textContent = error.message;
    return false;
  } finally {
    button.disabled = false;
  }
}

const purchaseModal = $('[data-purchase-modal]');
const vipModal = $('[data-vip-modal]');
const vipSuccess = $('[data-vip-success]');
$('[data-open-purchase]')?.addEventListener('click', () => setModal(purchaseModal, true));
$('[data-close-purchase]')?.addEventListener('click', () => setModal(purchaseModal, false));
$('[data-open-vip]')?.addEventListener('click', () => setModal(vipModal, true));
$('[data-close-vip]')?.addEventListener('click', () => setModal(vipModal, false));
$$('[data-close-vip-success]').forEach((button) => button.addEventListener('click', () => setModal(vipSuccess, false)));
[purchaseModal, vipModal, vipSuccess].forEach((modal) => modal?.addEventListener('click', (event) => { if (event.target === modal) setModal(modal, false); }));

$('[data-purchase-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await submitLead(event.currentTarget, 'purchase_intent', $('[data-purchase-status]'))) {
    setModal(purchaseModal, false);
    window.location.href = checkoutUrl;
  }
});

$('[data-vip-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (await submitLead(event.currentTarget, 'vip_application', $('[data-vip-status]'))) {
    setModal(vipModal, false);
    setModal(vipSuccess, true);
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  [purchaseModal, vipModal, vipSuccess].forEach((modal) => { if (modal && !modal.hidden) setModal(modal, false); });
});

updateMemberCtas();
