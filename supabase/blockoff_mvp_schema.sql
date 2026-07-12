create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  account_type text not null default 'creator' check (account_type in ('creator', 'brand')),
  protection_mode text not null default 'review_first' check (protection_mode in ('review_first', 'auto_high_confidence')),
  onboarding_completed boolean not null default false,
  brand_names text[] not null default '{}',
  sensitive_keywords text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.connected_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('youtube', 'instagram')),
  external_id text not null,
  display_name text,
  username text,
  status text not null default 'active' check (status in ('active', 'expired', 'disconnected', 'error')),
  token_encrypted text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, platform, external_id)
);

create table if not exists public.oauth_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('youtube', 'instagram')),
  state text not null unique,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.content_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('youtube', 'instagram')),
  external_id text not null,
  title text not null,
  thumbnail_url text,
  published_at timestamptz,
  comment_count integer not null default 0,
  view_count integer not null default 0,
  like_count integer not null default 0,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, platform, external_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connected_account_id uuid references public.connected_accounts(id) on delete set null,
  content_item_id uuid references public.content_items(id) on delete cascade,
  platform text not null check (platform in ('youtube', 'instagram')),
  external_id text not null,
  author_name text,
  author_external_id text,
  text text not null,
  status text not null default 'needs_review' check (status in ('needs_review', 'hidden', 'deleted', 'blocked', 'allowed', 'restored')),
  category text not null default 'review',
  recommended_action text not null default 'review',
  severity_score integer not null default 0,
  engagement_score integer not null default 0,
  brand_risk_score integer not null default 0,
  creator_risk_score integer not null default 0,
  priority_score integer not null default 0,
  reason text,
  like_count integer not null default 0,
  reply_count integer not null default 0,
  published_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, platform, external_id)
);

create table if not exists public.scan_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('youtube', 'instagram')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  content_item_ids uuid[] not null default '{}',
  result jsonb not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connected_account_id uuid references public.connected_accounts(id) on delete set null,
  comment_id uuid references public.comments(id) on delete set null,
  platform text not null check (platform in ('youtube', 'instagram')),
  action text not null check (action in ('hide', 'delete', 'blockoff', 'allow', 'restore', 'keep_review')),
  status text not null default 'completed',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.comment_training_labels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  comment_id uuid references public.comments(id) on delete set null,
  moderation_action_id uuid references public.moderation_actions(id) on delete cascade,
  platform text not null check (platform in ('youtube', 'instagram')),
  label text not null check (label in ('bad_hide', 'bad_delete', 'bad_block_author', 'safe_allow', 'safe_restore', 'uncertain_review')),
  category text,
  comment_text text not null,
  model_version text,
  model_prediction jsonb not null default '{}',
  reviewer_metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null default 'keyword',
  value text not null,
  action text not null default 'review',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, type, value)
);

create table if not exists public.quota_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('youtube', 'instagram', 'ai')),
  date date not null default current_date,
  operation text not null,
  units_used integer not null default 0,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.quota_usage drop constraint if exists quota_usage_platform_check;
alter table public.quota_usage
  add constraint quota_usage_platform_check
  check (platform in ('youtube', 'instagram', 'ai'));

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'dodo',
  provider_customer_id text,
  provider_subscription_id text,
  status text not null default 'manual',
  plan text not null default 'founding',
  lifetime_discount_percent numeric not null default 66.67,
  current_period_end timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text,
  title text not null,
  detail text,
  created_at timestamptz not null default now()
);

create table if not exists public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  provider text not null default 'dodo',
  reason text not null,
  experience text,
  status text not null default 'submitted' check (status in ('submitted', 'reviewing', 'approved', 'rejected', 'refunded')),
  provider_refund_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'dodo',
  provider_event_id text not null unique,
  event_type text not null,
  user_id uuid references auth.users(id) on delete set null,
  status text not null default 'processed',
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.connected_accounts enable row level security;
alter table public.oauth_states enable row level security;
alter table public.content_items enable row level security;
alter table public.comments enable row level security;
alter table public.scan_jobs enable row level security;
alter table public.moderation_actions enable row level security;
alter table public.comment_training_labels enable row level security;
alter table public.rules enable row level security;
alter table public.quota_usage enable row level security;
alter table public.subscriptions enable row level security;
alter table public.activity_logs enable row level security;
alter table public.refund_requests enable row level security;
alter table public.payment_webhook_events enable row level security;

drop policy if exists "profiles owner read" on public.profiles;
create policy "profiles owner read" on public.profiles for select using (auth.uid() = id);
drop policy if exists "profiles owner update" on public.profiles;
create policy "profiles owner update" on public.profiles for update using (auth.uid() = id);

drop policy if exists "connected accounts owner read" on public.connected_accounts;
create policy "connected accounts owner read" on public.connected_accounts for select using (auth.uid() = user_id);

drop policy if exists "content owner read" on public.content_items;
create policy "content owner read" on public.content_items for select using (auth.uid() = user_id);

drop policy if exists "comments owner read" on public.comments;
create policy "comments owner read" on public.comments for select using (auth.uid() = user_id);

drop policy if exists "actions owner read" on public.moderation_actions;
create policy "actions owner read" on public.moderation_actions for select using (auth.uid() = user_id);

drop policy if exists "training labels owner read" on public.comment_training_labels;
create policy "training labels owner read" on public.comment_training_labels for select using (auth.uid() = user_id);

drop policy if exists "rules owner read" on public.rules;
create policy "rules owner read" on public.rules for select using (auth.uid() = user_id);
drop policy if exists "rules owner insert" on public.rules;
create policy "rules owner insert" on public.rules for insert with check (auth.uid() = user_id);
drop policy if exists "rules owner update" on public.rules;
create policy "rules owner update" on public.rules for update using (auth.uid() = user_id);
drop policy if exists "rules owner delete" on public.rules;
create policy "rules owner delete" on public.rules for delete using (auth.uid() = user_id);

drop policy if exists "quota owner read" on public.quota_usage;
create policy "quota owner read" on public.quota_usage for select using (auth.uid() = user_id);

drop policy if exists "subscriptions owner read" on public.subscriptions;
create policy "subscriptions owner read" on public.subscriptions for select using (auth.uid() = user_id);

drop policy if exists "activity owner read" on public.activity_logs;
create policy "activity owner read" on public.activity_logs for select using (auth.uid() = user_id);
drop policy if exists "refund requests owner read" on public.refund_requests;
create policy "refund requests owner read" on public.refund_requests for select using (auth.uid() = user_id);

create index if not exists comments_user_priority_idx on public.comments (user_id, priority_score desc);
create index if not exists training_labels_user_created_idx on public.comment_training_labels (user_id, created_at desc);
create index if not exists comments_content_priority_idx on public.comments (content_item_id, priority_score desc);
create index if not exists comments_text_search_idx on public.comments using gin (text gin_trgm_ops);
create index if not exists content_user_platform_idx on public.content_items (user_id, platform, published_at desc);
create index if not exists activity_user_created_idx on public.activity_logs (user_id, created_at desc);
create index if not exists accounts_user_platform_status_idx on public.connected_accounts (user_id, platform, status, created_at desc);
create index if not exists scan_jobs_user_status_created_idx on public.scan_jobs (user_id, status, created_at desc);
create index if not exists quota_user_date_idx on public.quota_usage (user_id, date, platform);
