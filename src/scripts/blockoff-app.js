import { blockoffSupabase as supabase } from '../lib/blockoff/client.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  session: null,
  profile: null,
  accounts: [],
  content: {
    youtube: [],
    instagram: [],
  },
  comments: [],
  activity: [],
  rules: [],
  previewComments: {},
  autoScan: { enabled: false, plan: null },
  subscription: null,
  selected: new Set(),
  activeView: 'overview',
  activeCommentFilter: 'all',
};

let activeSessionToken = null;
let bootstrapRequest = null;
let searchTimer = null;
const oauthSignalKey = 'blockoff_oauth_result';

function fmt(value) {
  return new Intl.NumberFormat('en-US').format(Number(value || 0));
}

function setStatus(message, type = 'info') {
  const el = $('[data-route-message]');
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || '';
  el.dataset.type = type;
}

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Please log in again.');
  return { authorization: `Bearer ${token}` };
}

async function api(path, options = {}) {
  const headers = await authHeaders();
  const response = await fetch(path, {
    ...options,
    headers: {
      ...headers,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message || JSON.stringify(data.error || {});
    const error = new Error(message || 'Request failed.');
    error.status = response.status;
    error.code = data.code || null;
    throw error;
  }
  return data;
}

function showAuth(show, loading = false) {
  const authScreen = $('[data-auth-screen]');
  const dashboard = $('[data-dashboard]');
  authScreen.hidden = !show;
  $('[data-auth-loading]').hidden = !loading;
  $('[data-auth-content]').hidden = loading;
  dashboard.classList.toggle('is-locked', show);
  dashboard.setAttribute('aria-busy', String(loading));
  if (show && !loading) {
    window.requestAnimationFrame(() => $('[data-auth-google]')?.focus());
  }
}

function showView(view) {
  state.activeView = view;
  $$('[data-view-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== view && !(view === 'overview' && panel.dataset.viewPanel === 'overview');
  });
  $$('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
}

function accountFor(platform) {
  return state.accounts.find((account) => account.platform === platform && account.status === 'active');
}

function renderStats() {
  const scanned = state.comments.length;
  const review = state.comments.filter((comment) => comment.status === 'needs_review').length;
  const hidden = state.comments.filter((comment) => ['hidden', 'blocked', 'deleted'].includes(comment.status)).length;
  const flagged = review + hidden;
  const protectedRate = flagged ? Math.round((hidden / flagged) * 100) : 100;
  const healthScore = Math.max(0, Math.min(100, 100 - Math.min(70, review * 4) + Math.min(12, hidden)));
  $('[data-stat-scanned]').textContent = fmt(scanned);
  $('[data-stat-review]').textContent = fmt(review);
  $('[data-stat-hidden]').textContent = fmt(hidden);
  $('[data-stat-protected]').textContent = `${protectedRate}%`;
  $('[data-health-score]').textContent = healthScore;
  $('[data-protection-mode]').textContent = state.profile?.protection_mode === 'auto_high_confidence' ? 'Auto high confidence' : 'Review first';
}

function renderOverview() {
  const categories = new Map();
  state.comments.forEach((comment) => {
    const key = comment.category || 'review';
    categories.set(key, (categories.get(key) || 0) + 1);
  });
  const total = Math.max(1, state.comments.length);
  const chart = $('[data-risk-chart]');
  if (chart) {
    const labels = { scam: 'Scams', abuse: 'Abuse', brand: 'Brand risk', brand_harm: 'Brand risk', creator_harm: 'Creator attacks', review: 'Needs judgment' };
    const rows = [...categories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    chart.innerHTML = rows.length ? rows.map(([key, count]) => `<div><span>${escapeHtml(labels[key] || key.replaceAll('_', ' '))}</span><i><b style="width:${Math.max(8, Math.round((count / total) * 100))}%"></b></i><strong>${count}</strong></div>`).join('') : '<p>Your risk breakdown will appear after the first scan.</p>';
  }
  const attention = $('[data-overview-attention]');
  if (attention) {
    const review = state.comments.filter((comment) => comment.status === 'needs_review').length;
    const hasAccount = state.accounts.some((account) => account.status === 'active');
    attention.innerHTML = !hasAccount
      ? '<strong>Connect your first channel</strong><p>Bring in recent videos or posts and run a quick scan.</p><button class="bo-action" type="button" data-view="youtube">Connect YouTube</button>'
      : review
        ? `<strong>${fmt(review)} comment${review === 1 ? '' : 's'} waiting</strong><p>Review the highest-impact comments first.</p><button class="bo-action bo-action-red" type="button" data-view="queue">Open review queue</button>`
        : '<strong>You are all caught up</strong><p>No flagged comments need your attention right now.</p>';
  }
}

function renderConnectionButtons() {
  $$('[data-connect-platform]').forEach((button) => {
    const connected = Boolean(accountFor(button.dataset.connectPlatform));
    button.classList.toggle('is-connected', connected);
    button.textContent = connected ? `${button.dataset.connectPlatform === 'youtube' ? 'YouTube' : 'Instagram'} connected` : `Connect ${button.dataset.connectPlatform === 'youtube' ? 'YouTube' : 'Instagram'}`;
    button.setAttribute('aria-disabled', String(connected));
  });
}

function renderSelectedScanButtons() {
  $$('[data-run-selected-scan]').forEach((button) => {
    const panel = button.closest('[data-view-panel]');
    const platform = panel?.dataset.viewPanel;
    const count = [...state.selected].filter((id) => state.content[platform]?.some((item) => item.id === id)).length;
    button.hidden = count === 0;
    button.textContent = count ? `Scan selected (${count})` : 'Run selected scan';
  });
}

function renderOnboarding() {
  const onboarding = $('[data-onboarding]');
  if (!onboarding) return;
  const needsOnboarding = Boolean(state.session && state.profile && !state.profile.onboarding_completed);
  onboarding.hidden = !needsOnboarding;
  $('[data-dashboard]')?.classList.toggle('is-locked', needsOnboarding || !state.session);
  if (needsOnboarding) {
    const form = $('[data-onboarding-form]');
    if (form) {
      const mode = form.elements.namedItem('mode');
      const protectionMode = form.elements.namedItem('protection_mode');
      if (mode?.value !== state.profile.account_type) {
        const matchingMode = form.querySelector(`[name="mode"][value="${state.profile.account_type || 'creator'}"]`);
        if (matchingMode) matchingMode.checked = true;
      }
      if (protectionMode?.value !== state.profile.protection_mode) {
        const matchingProtection = form.querySelector(`[name="protection_mode"][value="${state.profile.protection_mode || 'review_first'}"]`);
        if (matchingProtection) matchingProtection.checked = true;
      }
      form.elements.namedItem('brand_names').value = (state.profile.brand_names || []).join(', ');
      form.elements.namedItem('keywords').value = (state.profile.sensitive_keywords || []).join(', ');
    }
  }
}

function contentRow(item) {
  const checked = state.selected.has(item.id) ? 'checked' : '';
  const thumbnail = item.thumbnail_url
    ? `<img src="${escapeHtml(item.thumbnail_url)}" alt="" loading="lazy" />`
    : `<div class="bo-thumb-fallback">${item.platform === 'youtube' ? 'YT' : 'IG'}</div>`;
  const risk = Number(item.risk_score || Math.max(...(item.top_comments || []).map((comment) => comment.priority_score || 0), 0));
  const comments = item.top_comments || [];
  return `
    <article class="bo-content-row" data-content-id="${escapeHtml(item.id)}" data-platform="${escapeHtml(item.platform)}">
      <label class="bo-row-select">
        <input type="checkbox" aria-label="Select ${escapeHtml(item.title || 'content')}" data-select-content="${escapeHtml(item.id)}" ${checked} />
      </label>
      <button class="bo-content-open" type="button" data-open-content="${escapeHtml(item.id)}">
        ${thumbnail}
        <span>
          <strong>${escapeHtml(item.title || 'Untitled')}</strong>
          <small>${fmt(item.view_count)} views or reach - ${fmt(item.comment_count)} comments</small>
        </span>
      </button>
      <div class="bo-risk-badge ${risk >= 80 ? 'hot' : risk >= 45 ? 'warm' : ''}">
        <b>${risk}</b>
        <span>risk</span>
      </div>
      <button class="bo-action bo-action-ghost" type="button" data-preview-scan="${escapeHtml(item.id)}">Preview 10</button>
      <div class="bo-top-comment-preview">
        ${comments.slice(0, 2).map((comment) => `<span>${escapeHtml(comment.text || '')}</span>`).join('') || '<span>No preview scan yet.</span>'}
      </div>
    </article>
  `;
}

function renderContent(platform) {
  const list = $(`[data-content-list="${platform}"]`);
  const detail = $(`[data-detail-panel="${platform}"]`);
  if (!list || !detail) return;

  const connected = accountFor(platform);
  const query = ($(`[data-content-search="${platform}"]`)?.value || '').trim().toLowerCase();
  const dateFilter = $(`[data-date-filter="${platform}"]`)?.value || 'all';
  const rows = (state.content[platform] || []).filter((item) => {
    const matchesText = !query
      || String(item.title || '').toLowerCase().includes(query)
      || (item.top_comments || []).some((comment) => String(comment.text || '').toLowerCase().includes(query));
    return matchesText && matchesDateFilter(item, dateFilter);
  });

  if (!connected && !rows.length) {
    list.innerHTML = emptyState(platform);
  } else if (!rows.length) {
    list.innerHTML = `<div class="bo-empty-state"><strong>No ${platform === 'youtube' ? 'videos' : 'posts'} loaded yet.</strong><span>Connect or refresh to pull the latest items.</span></div>`;
  } else {
    list.innerHTML = rows.map(contentRow).join('');
  }

  const first = rows[0];
  detail.innerHTML = first ? detailPanel(first) : setupPanel(platform);
}

function matchesDateFilter(item, filter) {
  if (!filter || filter === 'all') return true;
  const publishedAt = item.published_at ? new Date(item.published_at) : null;
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) return true;
  if (/^\d+$/.test(filter)) {
    return publishedAt.getTime() >= Date.now() - Number(filter) * 86400000;
  }
  if (filter.startsWith('month:')) {
    const [year, month] = filter.replace('month:', '').split('-').map(Number);
    return publishedAt.getUTCFullYear() === year && publishedAt.getUTCMonth() + 1 === month;
  }
  if (filter.startsWith('year:')) {
    return publishedAt.getUTCFullYear() === Number(filter.replace('year:', ''));
  }
  return true;
}

function emptyState(platform) {
  const title = platform === 'youtube' ? 'Connect YouTube to fetch real videos.' : 'Connect Instagram after the Business/Creator setup.';
  const body = platform === 'youtube'
    ? 'Until then, demo mode shows the exact selection and review flow using sample content.'
    : 'Instagram needs a Business or Creator account before comments can be scanned.';
  return `<div class="bo-empty-state"><strong>${title}</strong><span>${body}</span><button class="bo-action" type="button" data-connect-platform="${platform}">Connect ${platform}</button></div>`;
}

function setupPanel(platform) {
  if (platform === 'instagram') {
    return `
      <div class="bo-detail-empty">
        <span class="bo-mini-kicker">Instagram setup</span>
        <h3>Before connecting</h3>
        <ol>
          <li>Switch Instagram to Business or Creator.</li>
          <li>Stay added as an app tester while Block OFF is in development mode.</li>
          <li>Authorize Block OFF through Instagram Business Login.</li>
        </ol>
      </div>
    `;
  }

  return `
    <div class="bo-detail-empty">
      <span class="bo-mini-kicker">YouTube setup</span>
      <h3>Connect once, scan on demand.</h3>
      <p>We request YouTube moderation permission only when connecting your channel.</p>
    </div>
  `;
}

function detailPanel(item) {
  return `
    <div class="bo-detail-empty">
      <span class="bo-mini-kicker">${item.platform}</span>
      <h3>${escapeHtml(item.title || 'Selected item')}</h3>
      <p>${fmt(item.comment_count)} comments. Select this item and run a scan to pull the latest risky comments.</p>
      <button class="bo-action bo-action-red" type="button" data-single-scan="${escapeHtml(item.id)}">Scan this item</button>
    </div>
  `;
}

function metricBar(value, max) {
  const width = max ? Math.max(4, Math.round((Number(value || 0) / max) * 100)) : 4;
  return `<span style="width:${width}%"></span>`;
}

function modalCommentCard(comment) {
  const actionMenu = `<div class="bo-review-actions">${reviewRowActions(comment)}</div>`;
  return `
    <article class="bo-modal-comment">
      <div>
        <strong>${escapeHtml(comment.author_name || 'Unknown commenter')}</strong>
        <p>${escapeHtml(comment.text || '')}</p>
        <small>${fmt(comment.like_count)} likes / ${fmt(comment.reply_count)} replies - ${escapeHtml(comment.reason || comment.category || 'comment')}</small>
      </div>
      ${actionMenu}
    </article>
  `;
}

function openReviewModal(itemId) {
  const item = [...state.content.youtube, ...state.content.instagram].find((row) => row.id === itemId);
  if (!item) return;
  const modal = $('[data-review-modal]');
  const body = $('[data-review-modal-body]');
  const comments = [
    ...(state.previewComments[item.id] || []),
    ...state.comments.filter((comment) => comment.content_item_id === item.id),
    ...(item.top_comments || []),
  ].filter((comment, index, list) => list.findIndex((row) => row.id === comment.id) === index);
  const maxMetric = Math.max(Number(item.view_count || 0), Number(item.like_count || 0), Number(item.comment_count || 0), 1);

  body.innerHTML = `
    <header class="bo-review-modal-head">
      <div>
        <span class="bo-mini-kicker">${escapeHtml(item.platform)} review</span>
        <h2 id="bo-review-title">${escapeHtml(item.title || 'Selected content')}</h2>
      </div>
      <div class="bo-inline-actions">
        <button class="bo-action bo-action-red" type="button" data-single-scan="${escapeHtml(item.id)}">Scan this ${item.platform === 'youtube' ? 'video' : 'post'}</button>
        <button class="bo-action bo-action-ghost" type="button" data-close-review>Close</button>
      </div>
    </header>
    <div class="bo-review-modal-grid">
      <div class="bo-review-media">
        ${item.thumbnail_url ? `<img src="${escapeHtml(item.thumbnail_url)}" alt="" />` : `<div class="bo-thumb-fallback">${item.platform === 'youtube' ? 'YT' : 'IG'}</div>`}
      </div>
      <div class="bo-review-stats">
        <div><strong>${fmt(item.view_count)}</strong><span>views/reach</span><i>${metricBar(item.view_count, maxMetric)}</i></div>
        <div><strong>${fmt(item.like_count)}</strong><span>likes</span><i>${metricBar(item.like_count, maxMetric)}</i></div>
        <div><strong>${fmt(item.comment_count)}</strong><span>comments</span><i>${metricBar(item.comment_count, maxMetric)}</i></div>
      </div>
    </div>
    <section class="bo-modal-comments">
      <div class="bo-modal-comments-head">
        <h3>Comments</h3>
        <button class="bo-action bo-action-red" type="button" data-preview-scan="${escapeHtml(item.id)}">Load latest 10</button>
      </div>
      <div class="bo-modal-comment-list">
        ${comments.length
          ? comments.slice(0, 10).map(modalCommentCard).join('')
          : '<div class="bo-empty-state"><strong>No comments loaded yet.</strong><span>Load latest 10 to preview this comment section.</span></div>'}
      </div>
      <div class="bo-paid-note">Browsing beyond 10 comments will be a paid-plan control when public launch limits are enabled.</div>
    </section>
  `;
  modal.hidden = false;
}

function closeReviewModal() {
  const modal = $('[data-review-modal]');
  if (modal) modal.hidden = true;
}

function moderationState(comment) {
  const status = comment.status || 'needs_review';
  if (status === 'hidden') return { label: 'Hidden', className: 'hidden', note: 'Removed from public view', undo: 'restore', undoLabel: 'Undo hide' };
  if (status === 'blocked') return { label: 'Author blocked', className: 'blocked', note: 'YouTube does not provide an API to undo an author ban' };
  if (status === 'deleted') return { label: 'Deleted', className: 'deleted', note: 'Permanently removed' };
  if (status === 'restored') return { label: 'Restored', className: 'restored', note: 'Visible publicly again' };
  if (status === 'allowed') return { label: 'Allowed', className: 'allowed', note: 'Kept visible' };
  return { label: 'Needs review', className: 'review', note: 'Waiting for your decision' };
}

function reviewRowActions(comment) {
  const stateInfo = moderationState(comment);
  if (stateInfo.undo) {
    return `<span class="bo-action-state ${stateInfo.className}"><strong>${stateInfo.label}</strong><small>${stateInfo.note}</small></span><button class="bo-action bo-action-ghost" type="button" data-comment-action="${stateInfo.undo}" data-comment-id="${escapeHtml(comment.id)}">${stateInfo.undoLabel}</button>`;
  }
  if (['blocked', 'deleted', 'restored', 'allowed'].includes(comment.status)) {
    return `<span class="bo-action-state ${stateInfo.className}"><strong>${stateInfo.label}</strong><small>${stateInfo.note}</small></span>${comment.status === 'restored' ? `<button class="bo-action" type="button" data-comment-action="hide" data-comment-id="${escapeHtml(comment.id)}">Hide again</button>` : ''}`;
  }
  if (comment.demo) return `<span class="bo-demo-label">Demo preview</span><button class="bo-action" type="button" data-connect-platform="${escapeHtml(comment.platform)}">Connect to act</button>`;
  return `
    <button class="bo-action bo-action-ghost" type="button" data-comment-action="allow" data-comment-id="${escapeHtml(comment.id)}">Allow</button>
    <button class="bo-action" type="button" title="Remove this comment from public view" data-comment-action="hide" data-comment-id="${escapeHtml(comment.id)}">Hide</button>
    ${comment.platform === 'youtube'
      ? `<button class="bo-action bo-action-red" type="button" title="Hide this comment and ban the author from your channel" data-comment-action="blockoff" data-comment-id="${escapeHtml(comment.id)}">Block OFF</button>`
      : `<button class="bo-action bo-action-red" type="button" title="Permanently delete this Instagram comment" data-comment-action="delete" data-comment-id="${escapeHtml(comment.id)}">Delete</button>`}
  `;
}

function renderComments() {
  const stream = $('[data-comment-stream]');
  if (!stream) return;
  const query = ($('[data-comment-search]')?.value || '').toLowerCase();
  const platform = $('[data-platform-filter]')?.value || 'all';
  const comments = state.comments
    .filter((comment) => state.activeCommentFilter === 'all' || comment.category === state.activeCommentFilter)
    .filter((comment) => platform === 'all' || comment.platform === platform)
    .filter((comment) => !query || comment.text?.toLowerCase().includes(query))
    .sort((a, b) => Number(b.priority_score || 0) - Number(a.priority_score || 0));

  if (!comments.length) {
    stream.innerHTML = `<div class="bo-empty-state"><strong>No comments in this view.</strong><span>Run a scan or change filters.</span></div>`;
    return;
  }

  stream.innerHTML = comments.map((comment) => `
    <article class="bo-review-row" data-comment-id="${escapeHtml(comment.id)}" data-category="${escapeHtml(comment.category)}">
      <div class="bo-comment-score ${comment.priority_score >= 80 ? 'hot' : ''}">
        <b>${comment.priority_score || 0}</b>
        <span>priority</span>
      </div>
      <div class="bo-review-body">
        <div class="bo-review-meta">
          <span>${comment.platform}</span>
          <span>${comment.category || 'review'}</span>
          <span>${fmt(comment.like_count)} likes / ${fmt(comment.reply_count)} replies</span>
        </div>
        <p>${escapeHtml(comment.text || '')}</p>
        <small>${escapeHtml(comment.reason || 'Flagged by moderation rules')}</small>
      </div>
      <div class="bo-review-actions">
        ${reviewRowActions(comment)}
      </div>
    </article>
  `).join('');
}

function renderActivity() {
  const list = $('[data-activity-list]');
  if (!list) return;
  list.innerHTML = (state.activity || []).map((item) => `
    <li>
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.detail || '')}</span>
    </li>
  `).join('') || '<li><strong>No activity yet.</strong><span>Connect a platform or run a scan.</span></li>';
}

function renderRules() {
  const defaults = new Map([
    ['scam_links', true],
    ['engagement_priority', true],
    ['constructive_shield', true],
    ['brand_risk', true],
  ]);
  (state.rules || [])
    .filter((rule) => rule.type === 'system')
    .forEach((rule) => defaults.set(rule.value, Boolean(rule.enabled)));

  $$('[data-rule-toggle]').forEach((input) => {
    input.checked = defaults.get(input.dataset.ruleToggle) ?? true;
  });
}

function renderAutoScan() {
  const toggle = $('[data-auto-scan-toggle]');
  if (!toggle) return;
  const enabled = Boolean(state.autoScan?.enabled);
  toggle.classList.toggle('active', enabled);
  toggle.setAttribute('aria-pressed', String(enabled));
  $('[data-auto-scan-label]').textContent = enabled ? 'Auto scans on' : 'Auto scans paused';
  const plan = state.autoScan?.plan;
  toggle.title = enabled
    ? 'Continuous protection is active for new and high-activity content.'
    : 'Automated scans are paused. Manual previews and scans still work.';
}

function renderAll() {
  $('[data-session-email]').textContent = state.session?.user?.email || 'Logged in';
  renderOnboarding();
  renderStats();
  renderOverview();
  renderContent('youtube');
  renderContent('instagram');
  renderComments();
  renderActivity();
  renderRules();
  renderAutoScan();
  renderConnectionButtons();
  renderSelectedScanButtons();
}

function resetWorkspace() {
  state.profile = null;
  state.accounts = [];
  state.content = { youtube: [], instagram: [] };
  state.comments = [];
  state.activity = [];
  state.rules = [];
  state.quota = [];
  state.selected.clear();
  renderAll();
}

async function hydrateSession(session) {
  state.session = session;
  activeSessionToken = session?.access_token || null;

  if (!session) {
    resetWorkspace();
    showAuth(true, false);
    return;
  }

  showAuth(false);
  setStatus('Loading your workspace...');

  try {
    const access = await api('/blockoff/api/access.json');
    if (!access.eligible) {
      window.location.href = '/blockoff/?access=required#pricing';
      return;
    }
    const payload = await api('/blockoff/api/bootstrap.json');
    state.profile = payload.profile;
    state.accounts = payload.accounts || [];
    state.comments = payload.comments || [];
    state.activity = payload.activity || [];
    state.rules = payload.rules || [];
    state.autoScan = payload.auto_scan || { enabled: false, plan: null };
    state.subscription = payload.subscription || null;
    state.quota = payload.quota || [];
    state.content.youtube = (payload.content || []).filter((item) => item.platform === 'youtube');
    state.content.instagram = (payload.content || []).filter((item) => item.platform === 'instagram');

    const connectedPlatform = new URLSearchParams(window.location.search).get('connected');
    await Promise.all([
      loadContent('youtube', false, connectedPlatform === 'youtube'),
      loadContent('instagram', false, connectedPlatform === 'instagram'),
    ]);
    routeMessage();
    showView('overview');
    renderAll();
    if (!state.profile?.onboarding_completed) {
      setStatus('');
    } else if (!$('[data-route-message]')?.textContent?.includes('connected')) {
      setStatus('');
    }
  } catch (error) {
    if (error.status === 402 || error.code === 'subscription_required') {
      window.location.href = '/blockoff/?access=required#pricing';
      return;
    }
    setStatus(error.message, 'error');
    if (/session expired|login required/i.test(error.message)) {
      await supabase.auth.signOut();
      showAuth(true, false);
    }
  } finally {
    $('[data-dashboard]').setAttribute('aria-busy', 'false');
  }
}

async function bootstrap(force = false) {
  if (bootstrapRequest && !force) return bootstrapRequest;
  bootstrapRequest = (async () => {
    showAuth(true, true);
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      $('[data-auth-status]').textContent = error.message;
      showAuth(true, false);
      return;
    }
    await hydrateSession(data.session);
  })();

  try {
    await bootstrapRequest;
  } finally {
    bootstrapRequest = null;
  }
}

async function loadContent(platform, announce = true, refresh = false) {
  try {
    if (announce) setStatus(`Refreshing ${platform}...`);
    const payload = await api(`/blockoff/api/content.json?platform=${platform}&refresh=${refresh ? '1' : '0'}`);
    state.content[platform] = payload.content || [];
    if (announce) setStatus(payload.demo ? `${platform} demo mode loaded.` : `${platform} refreshed.`, payload.demo ? 'info' : 'success');
    renderAll();
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function runScan(ids, previewOnly = false) {
  const contentIds = ids.length ? ids : Array.from(state.selected);
  if (!contentIds.length) {
    setStatus('Select at least one video or post first.', 'error');
    return;
  }

  setStatus(previewOnly ? 'Preview scanning top comments...' : 'Running selected scan...');
  try {
    const selectedItem = [...state.content.youtube, ...state.content.instagram]
      .find((item) => contentIds.includes(item.id));
    const platform = selectedItem?.platform || (state.activeView === 'instagram' ? 'instagram' : 'youtube');
    const payload = await api('/blockoff/api/scan.json', {
      method: 'POST',
      body: JSON.stringify({ content_ids: contentIds, preview_only: previewOnly, platform }),
    });
    const next = (payload.comments || []).map((comment) => ({ ...comment, demo: Boolean(payload.demo) }));
    if (previewOnly && contentIds.length === 1) {
      state.previewComments[contentIds[0]] = (payload.preview_comments || next).map((comment) => ({
        ...comment,
        demo: Boolean(payload.demo),
      }));
    }
    const existing = new Map(state.comments.map((comment) => [comment.id, comment]));
    next.forEach((comment) => existing.set(comment.id, comment));
    state.comments = Array.from(existing.values());
    const skipped = payload.skipped || [];
    const skippedMessage = skipped.length
      ? ` ${skipped.length} item${skipped.length === 1 ? ' has' : 's have'} comments disabled.`
      : '';
    setStatus(
      payload.demo
        ? `${next.length} demo comments ranked. Connect ${platform} to take live actions.`
        : `${payload.scanned || 0} comments checked. ${next.length} need review.${skippedMessage}`,
      payload.demo ? 'info' : 'success',
    );
    showView('queue');
    renderAll();
    if (previewOnly && contentIds.length === 1) openReviewModal(contentIds[0]);
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function commentAction(action, id) {
  const comment = state.comments.find((item) => item.id === id);
  if (comment?.demo) {
    setStatus(`Connect ${comment.platform} before taking a live moderation action.`, 'error');
    return;
  }

  const label = action === 'blockoff' ? 'Block OFF' : action;
  const confirmed = ['blockoff', 'hide', 'delete'].includes(action)
    ? window.confirm(`${label} this comment on the platform?`)
    : true;
  if (!confirmed) return;

  try {
    const payload = await api('/blockoff/api/comments/action.json', {
      method: 'POST',
      body: JSON.stringify({ action, comment_ids: [id] }),
    });
    state.comments = state.comments.map((comment) => (
      comment.id === id
        ? { ...comment, status: payload.status }
        : comment
    ));
    const successText = {
      hide: 'Comment hidden from public view.',
      restore: 'Comment restored and visible again.',
      blockoff: 'Comment hidden and author blocked from the channel.',
      delete: 'Comment permanently deleted.',
      allow: 'Comment marked as allowed.',
    }[action] || `Comment action completed: ${label}.`;
    setStatus(payload.already_applied ? 'That action was already applied.' : successText, 'success');
    renderAll();
    const modal = $('[data-review-modal]');
    if (modal && !modal.hidden && comment?.content_item_id) openReviewModal(comment.content_item_id);
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function connectPlatform(platform) {
  try {
    if (accountFor(platform)) {
      setStatus(`${platform === 'youtube' ? 'YouTube' : 'Instagram'} is already connected.`, 'success');
      renderConnectionButtons();
      return;
    }
    setStatus(`Opening ${platform} authorization...`);
    const payload = await api(`/blockoff/api/oauth/${platform}/start.json`, { method: 'POST', body: '{}' });
    const authWindow = window.open(payload.url, '_blank', 'noopener,noreferrer');
    if (!authWindow) {
      setStatus('Your browser blocked the authorization tab. Allow popups for this site and try again.', 'error');
      return;
    }
    setStatus(`Authorization opened in a new tab. Keep this app tab open; it will refresh when ${platform} connects.`, 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function toggleAutoScan() {
  const next = !Boolean(state.autoScan?.enabled);
  setStatus(next ? 'Resuming automated scans...' : 'Pausing automated scans...');
  try {
    const payload = await api('/blockoff/api/auto-scan.json', {
      method: 'POST',
      body: JSON.stringify({ enabled: next }),
    });
    state.rules = payload.rules || state.rules;
    state.autoScan = { enabled: payload.enabled, plan: payload.plan };
    renderAutoScan();
    setStatus(
      payload.enabled
        ? 'Continuous protection is on. New and active content will be checked automatically.'
        : 'Auto scans paused. Manual scans still work.',
      'success',
    );
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function saveRule(input) {
  const key = input.dataset.ruleToggle;
  const enabled = input.checked;
  input.disabled = true;
  try {
    const payload = await api('/blockoff/api/rules.json', {
      method: 'POST',
      body: JSON.stringify({ key, enabled }),
    });
    state.rules = payload.rules || state.rules;
    setStatus('Rule updated.', 'success');
  } catch (error) {
    input.checked = !enabled;
    setStatus(error.message, 'error');
  } finally {
    input.disabled = false;
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function routeMessage() {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get('connected');
  const error = params.get('error');
  if (connected) setStatus(`${connected} connected. Refreshing workspace...`, 'success');
  if (error) setStatus(decodeURIComponent(error), 'error');
  if (connected || error) {
    localStorage.setItem(oauthSignalKey, JSON.stringify({
      connected,
      error,
      at: Date.now(),
    }));
    window.history.replaceState({}, '', window.location.pathname);
    if (window.opener && !window.opener.closed) {
      window.setTimeout(() => window.close(), 900);
    }
  }
}

window.addEventListener('storage', (event) => {
  if (event.key !== oauthSignalKey || !event.newValue) return;
  try {
    const payload = JSON.parse(event.newValue);
    if (payload.connected) {
      setStatus(`${payload.connected} connected. Loading your channel...`, 'success');
      bootstrap(true);
    } else if (payload.error) {
      setStatus(decodeURIComponent(payload.error), 'error');
    }
  } catch {
    bootstrap(true);
  }
});

window.addEventListener('focus', () => {
  const raw = localStorage.getItem(oauthSignalKey);
  if (!raw) return;
  try {
    const payload = JSON.parse(raw);
    if (Date.now() - Number(payload.at || 0) < 2 * 60 * 1000 && payload.connected) {
      bootstrap(true);
    }
  } catch {
    // Ignore stale/malformed OAuth signals.
  }
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button, a');
  if (!target) return;

  if (target.matches('[data-auth-google]')) {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/blockoff/app` },
    });
    if (error) $('[data-auth-status]').textContent = error.message;
  }

  if (target.matches('[data-logout]')) {
    await supabase.auth.signOut();
  }

  if (target.matches('[data-view]')) showView(target.dataset.view);
  if (target.matches('[data-connect-platform]')) connectPlatform(target.dataset.connectPlatform);
  if (target.matches('[data-auto-scan-toggle]')) toggleAutoScan();
  if (target.matches('[data-refresh-content]')) loadContent(target.dataset.refreshContent, true, true);
  if (target.matches('[data-run-selected-scan]')) runScan([]);
  if (target.matches('[data-quick-scan]')) {
    const connected = ['youtube', 'instagram'].find((platform) => accountFor(platform) && state.content[platform].length);
    const ids = connected ? state.content[connected].slice(0, 3).map((item) => item.id) : [];
    if (ids.length) runScan(ids, true);
    else {
      showView('youtube');
      setStatus('Connect YouTube or Instagram, then run your first quick scan.', 'info');
    }
  }
  if (target.matches('[data-preview-scan]')) runScan([target.dataset.previewScan], true);
  if (target.matches('[data-single-scan]')) runScan([target.dataset.singleScan]);
  if (target.matches('[data-close-review]')) closeReviewModal();

  if (target.matches('[data-comment-filter]')) {
    state.activeCommentFilter = target.dataset.commentFilter;
    $$('[data-comment-filter]').forEach((button) => button.classList.toggle('active', button === target));
    renderComments();
  }

  if (target.matches('[data-comment-action]')) {
    commentAction(target.dataset.commentAction, target.dataset.commentId);
  }

  if (target.matches('[data-open-content]')) {
    const id = target.dataset.openContent;
    const item = [...state.content.youtube, ...state.content.instagram].find((row) => row.id === id);
    if (item) {
      $(`[data-detail-panel="${item.platform}"]`).innerHTML = detailPanel(item);
      openReviewModal(id);
    }
  }

  if (target.matches('[data-password-toggle]')) {
    const input = $('[data-password-input]');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    target.setAttribute('aria-pressed', String(show));
    target.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    input.focus();
  }
});

$('[data-review-modal]')?.addEventListener('click', (event) => {
  if (event.target.matches('[data-close-review]')) closeReviewModal();
});

document.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.matches('[data-select-content]')) {
    if (target.checked) state.selected.add(target.dataset.selectContent);
    else state.selected.delete(target.dataset.selectContent);
    renderSelectedScanButtons();
  }
  if (target.matches('[data-date-filter]')) renderContent(target.dataset.dateFilter);
  if (target.matches('[data-platform-filter]')) renderComments();
  if (target.matches('[data-rule-toggle]')) await saveRule(target);
});

document.addEventListener('input', (event) => {
  if (event.target.matches('[data-comment-search]')) {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(renderComments, 120);
  }
  if (event.target.matches('[data-content-search]')) {
    renderContent(event.target.dataset.contentSearch);
  }
});

$('[data-email-auth]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitter = event.submitter;
  const mode = submitter?.dataset.authMode || 'signin';
  const formData = new FormData(event.currentTarget);
  const email = String(formData.get('email') || '').trim();
  const password = String(formData.get('password') || '');
  const status = $('[data-auth-status]');
  if (password.length < 6) {
    status.textContent = 'Password must be at least 6 characters.';
    return;
  }
  status.textContent = mode === 'signup' ? 'Creating account...' : 'Signing in...';

  const result = mode === 'signup'
    ? await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/blockoff/app` } })
    : await supabase.auth.signInWithPassword({ email, password });

  if (result.error) {
    status.textContent = result.error.message;
    return;
  }

  if (mode === 'signup' && !result.data?.session) {
    status.textContent = 'Account created. Open the confirmation email, then return here to sign in.';
    return;
  }

  status.textContent = 'Signed in. Loading your workspace...';
  await hydrateSession(result.data.session);
});

$('[data-onboarding-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const split = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  const submitButton = event.submitter || event.currentTarget.querySelector('[type="submit"]');
  const status = $('[data-onboarding-status]');
  submitButton.disabled = true;
  status.textContent = 'Saving your workspace...';
  try {
    const payload = await api('/blockoff/api/onboarding.json', {
      method: 'POST',
      body: JSON.stringify({
        mode: formData.get('mode'),
        protection_mode: formData.get('protection_mode'),
        brand_names: split(formData.get('brand_names')),
        keywords: split(formData.get('keywords')),
      }),
    });
    state.profile = payload.profile;
    setStatus('Workspace saved. Connect YouTube to start real scans.', 'success');
    status.textContent = '';
    renderAll();
    window.requestAnimationFrame(() => $('[data-connect-platform="youtube"]')?.focus());
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

supabase.auth.onAuthStateChange((event, session) => {
  state.session = session;
  if (event === 'SIGNED_OUT') {
    activeSessionToken = null;
    hydrateSession(null);
    return;
  }
  if (event === 'TOKEN_REFRESHED') {
    activeSessionToken = session?.access_token || null;
    return;
  }
  if (event === 'SIGNED_IN' && session?.access_token !== activeSessionToken) {
    hydrateSession(session);
  }
});

bootstrap();
