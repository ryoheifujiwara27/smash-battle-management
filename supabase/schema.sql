-- =========================================================
-- SMASH RECORD - Supabase スキーマ
-- ---------------------------------------------------------
-- Supabase ダッシュボードの SQL Editor に貼り付けて実行してください。
-- 何度実行しても同じ結果になります（冪等）。
-- =========================================================

-- ---------- テーブル ----------
-- id はクライアント生成の文字列。ユーザーをまたいだ衝突を避けるため
-- 主キーは (user_id, id) の複合とする。
create table if not exists public.battles (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  id         text        not null,
  date       timestamptz not null,
  my_char    text        not null,
  opp_char   text        not null,
  result     text        not null check (result in ('win', 'lose')),
  memo       text        not null default '',

  -- 論理削除。物理削除にすると他端末に削除が伝わらず復活してしまうため。
  deleted    boolean     not null default false,

  -- updated_at: クライアントが打刻する更新時刻。端末間の競合解決
  --   （last-write-wins）はこの値のみで比較する。
  -- synced_at: サーバー側の受信時刻。差分取得のカーソル用で、
  --   競合解決には使わない（クライアント時計と混ぜないため）。
  updated_at timestamptz not null default now(),
  synced_at  timestamptz not null default now(),

  primary key (user_id, id)
);

-- 差分取得用
create index if not exists battles_user_synced_idx
  on public.battles (user_id, synced_at desc);

-- ---------- synced_at をサーバー時刻で強制 ----------
-- クライアントが送ってきた synced_at は信用せず、必ず now() で上書きする。
create or replace function public.battles_set_synced_at()
returns trigger
language plpgsql
as $$
begin
  new.synced_at := now();
  return new;
end;
$$;

drop trigger if exists battles_set_synced_at on public.battles;
create trigger battles_set_synced_at
  before insert or update on public.battles
  for each row execute function public.battles_set_synced_at();

-- ---------- Row Level Security ----------
-- これがないと anon key を持つ誰でも全ユーザーのデータを読めてしまう。
alter table public.battles enable row level security;

drop policy if exists "battles_select_own" on public.battles;
create policy "battles_select_own" on public.battles
  for select using (auth.uid() = user_id);

drop policy if exists "battles_insert_own" on public.battles;
create policy "battles_insert_own" on public.battles
  for insert with check (auth.uid() = user_id);

drop policy if exists "battles_update_own" on public.battles;
create policy "battles_update_own" on public.battles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "battles_delete_own" on public.battles;
create policy "battles_delete_own" on public.battles
  for delete using (auth.uid() = user_id);
