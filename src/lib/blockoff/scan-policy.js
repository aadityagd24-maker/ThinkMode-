const DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_SCAN_POLICY = {
  enabled: false,
  youtubeDailyUnitBudget: 80,
  youtubeMaxVideosPerRun: 6,
  instagramMaxPostsPerRun: 12,
  recentWindowDays: 7,
  warmWindowDays: 30,
  oldVideoWeeklyLimit: 6,
};

function ageDays(item, now = Date.now()) {
  const published = item.published_at ? Date.parse(item.published_at) : 0;
  if (!published) return 9999;
  return Math.max(0, Math.floor((now - published) / DAY));
}

function lastScannedAt(item) {
  const value = item.metadata?.blockoff_last_scanned_at;
  return value ? Date.parse(value) || 0 : 0;
}

function commentVelocity(item) {
  const previous = Number(item.metadata?.blockoff_previous_comment_count || 0);
  const current = Number(item.comment_count || 0);
  const delta = Math.max(0, current - previous);
  const lastScan = lastScannedAt(item);
  const hours = lastScan ? Math.max(1, (Date.now() - lastScan) / 36e5) : 24;
  return delta / hours;
}

function dueIntervalHours(item, policy) {
  const age = ageDays(item);
  const velocity = commentVelocity(item);

  if (age <= policy.recentWindowDays) return velocity >= 2 ? 3 : 6;
  if (age <= policy.warmWindowDays) return velocity >= 1 ? 8 : 24;
  if (velocity >= 0.5) return 24;
  return 7 * 24;
}

function priorityScore(item, policy) {
  const age = ageDays(item);
  const velocity = commentVelocity(item);
  const comments = Number(item.comment_count || 0);
  const views = Number(item.view_count || 0);
  const freshness = age <= policy.recentWindowDays ? 80 : age <= policy.warmWindowDays ? 45 : 10;
  const traction = Math.min(40, velocity * 20) + Math.min(20, comments / 50) + Math.min(15, views / 2000);
  return Math.round(freshness + traction);
}

export function getScanSetting(rules = [], key, fallback = true) {
  const row = rules.find((rule) => rule.type === 'system' && rule.value === key);
  return row ? Boolean(row.enabled) : fallback;
}

export function buildAutoScanPlan(content = [], rules = [], policy = DEFAULT_SCAN_POLICY) {
  const enabled = getScanSetting(rules, 'auto_scans_enabled', policy.enabled);
  if (!enabled) {
    return { enabled: false, targets: [], reason: 'Auto scans are paused.' };
  }

  const now = Date.now();
  const candidates = content
    .map((item) => {
      const interval = dueIntervalHours(item, policy);
      const due = !lastScannedAt(item) || now - lastScannedAt(item) >= interval * 36e5;
      return {
        ...item,
        scan_age_days: ageDays(item, now),
        scan_due_hours: interval,
        scan_priority: priorityScore(item, policy),
        scan_due: due,
      };
    })
    .filter((item) => item.scan_due)
    .sort((a, b) => b.scan_priority - a.scan_priority);

  const youtube = candidates
    .filter((item) => item.platform === 'youtube')
    .slice(0, policy.youtubeMaxVideosPerRun);

  const instagram = candidates
    .filter((item) => item.platform === 'instagram')
    .slice(0, policy.instagramMaxPostsPerRun);

  return {
    enabled: true,
    targets: [...youtube, ...instagram],
    reason: 'Recent content is scanned first; older content is only scanned when it is still attracting comments.',
    policy,
  };
}
