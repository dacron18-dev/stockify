-- ============================================================
-- STOCKIFY: complete database setup
-- Paste ALL of this into Supabase -> SQL Editor -> New query -> Run.
-- Safe to re-run (it never deletes users, trades or holdings).
-- ============================================================

-- ---------- tables ----------
create table if not exists settings (
  id int primary key default 1 check (id = 1),
  start_cash numeric not null default 1000000,
  market_open boolean not null default true,
  price_source text not null default 'manual' check (price_source in ('manual','live')),
  last_fetch timestamptz
);
insert into settings (id) values (1) on conflict (id) do nothing;

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text not null,
  role text not null default 'customer' check (role in ('admin','customer')),
  cash numeric not null default 0 check (cash >= 0),
  created_at timestamptz not null default now()
);

create table if not exists stocks (
  symbol text primary key,
  name text not null,
  price numeric not null check (price > 0),
  prev_close numeric not null check (prev_close > 0),
  active boolean not null default true,
  api_symbol text,        -- symbol used by the price API (live mode)
  api_exchange text,      -- optional exchange for the price API, e.g. NSE
  updated_at timestamptz not null default now()
);

create table if not exists price_history (
  id bigserial primary key,
  symbol text not null references stocks(symbol) on delete cascade,
  price numeric not null,
  ts timestamptz not null default now()
);
create index if not exists price_history_idx on price_history (symbol, ts desc);

create table if not exists holdings (
  user_id uuid not null references profiles(id) on delete cascade,
  symbol text not null references stocks(symbol),
  qty int not null check (qty > 0),
  avg_price numeric not null,
  primary key (user_id, symbol)
);

create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  symbol text not null references stocks(symbol),
  side text not null check (side in ('BUY','SELL')),
  qty int not null check (qty > 0),
  price numeric not null,
  created_at timestamptz not null default now()
);
create index if not exists trades_user_idx on trades (user_id, created_at desc);

-- sample stocks (illustrative placeholder prices, set real ones in the Admin screen or via the API)
insert into stocks (symbol, name, price, prev_close, api_symbol, api_exchange) values
  ('RELIANCE',  'Reliance Industries', 2900, 2900, 'RELIANCE',  'NSE'),
  ('TCS',       'Tata Consultancy Services', 4100, 4100, 'TCS', 'NSE'),
  ('INFY',      'Infosys', 1800, 1800, 'INFY', 'NSE'),
  ('HDFCBANK',  'HDFC Bank', 1700, 1700, 'HDFCBANK', 'NSE'),
  ('ICICIBANK', 'ICICI Bank', 1250, 1250, 'ICICIBANK', 'NSE'),
  ('SBIN',      'State Bank of India', 800, 800, 'SBIN', 'NSE'),
  ('ITC',       'ITC', 460, 460, 'ITC', 'NSE'),
  ('LT',        'Larsen & Toubro', 3600, 3600, 'LT', 'NSE'),
  ('WIPRO',     'Wipro', 520, 520, 'WIPRO', 'NSE'),
  ('BHARTIARTL','Bharti Airtel', 1700, 1700, 'BHARTIARTL', 'NSE')
on conflict (symbol) do nothing;

-- ---------- helper: is the caller an admin? ----------
create or replace function is_admin() returns boolean language sql stable security definer set search_path = public as $body$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$body$;

-- ---------- new signup -> profile with starting cash ----------
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $body$
begin
  insert into profiles (id, email, name, role, cash)
  values (new.id, new.email,
          coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)),
          'customer',
          (select start_cash from settings where id = 1))
  on conflict (id) do nothing;
  return new;
end
$body$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- log every price change (for charts) ----------
create or replace function log_price() returns trigger language plpgsql security definer set search_path = public as $body$
begin
  if tg_op = 'INSERT' or new.price is distinct from old.price then
    insert into price_history (symbol, price) values (new.symbol, new.price);
  end if;
  return new;
end
$body$;

drop trigger if exists stocks_log_price on stocks;
create trigger stocks_log_price after insert or update of price on stocks
  for each row execute function log_price();

-- give every stock a first chart point
insert into price_history (symbol, price)
select symbol, price from stocks s
where not exists (select 1 from price_history h where h.symbol = s.symbol);

-- ---------- PLACE AN ORDER (the only way to trade; price comes from the server) ----------
create or replace function place_order(p_symbol text, p_side text, p_qty int) returns json
language plpgsql security definer set search_path = public as $body$
declare
  uid uuid := auth.uid();
  prof profiles%rowtype;
  stk stocks%rowtype;
  hold holdings%rowtype;
  amt numeric;
  is_open boolean;
begin
  if uid is null then raise exception 'Please log in'; end if;
  if p_side not in ('BUY','SELL') then raise exception 'Side must be BUY or SELL'; end if;
  if p_qty is null or p_qty < 1 then raise exception 'Quantity must be at least 1'; end if;

  select market_open into is_open from settings where id = 1;
  if not is_open then raise exception 'Market is closed right now'; end if;

  select * into stk from stocks where symbol = p_symbol;
  if not found then raise exception 'Unknown stock %', p_symbol; end if;
  if not stk.active then raise exception '% is not available for trading', p_symbol; end if;

  select * into prof from profiles where id = uid for update;   -- one order at a time per user
  if not found then raise exception 'Profile not found'; end if;

  amt := stk.price * p_qty;

  if p_side = 'BUY' then
    if prof.cash < amt then
      raise exception 'Not enough cash: need %, you have %', round(amt, 2), round(prof.cash, 2);
    end if;
    update profiles set cash = cash - amt where id = uid;
    insert into holdings (user_id, symbol, qty, avg_price) values (uid, p_symbol, p_qty, stk.price)
    on conflict (user_id, symbol) do update
      set avg_price = (holdings.avg_price * holdings.qty + excluded.avg_price * excluded.qty) / (holdings.qty + excluded.qty),
          qty = holdings.qty + excluded.qty;
  else
    select * into hold from holdings where user_id = uid and symbol = p_symbol for update;
    if not found or hold.qty < p_qty then
      raise exception 'You hold only % of %', coalesce(hold.qty, 0), p_symbol;
    end if;
    update profiles set cash = cash + amt where id = uid;
    if hold.qty = p_qty then
      delete from holdings where user_id = uid and symbol = p_symbol;
    else
      update holdings set qty = qty - p_qty where user_id = uid and symbol = p_symbol;
    end if;
  end if;

  insert into trades (user_id, symbol, side, qty, price) values (uid, p_symbol, p_side, p_qty, stk.price);
  return json_build_object('symbol', p_symbol, 'side', p_side, 'qty', p_qty, 'price', stk.price);
end
$body$;

-- ---------- leaderboard (names and totals only) ----------
create or replace function leaderboard() returns table (name text, total numeric, ret_pct numeric, is_me boolean)
language sql stable security definer set search_path = public as $body$
  with t as (
    select p.id, p.name,
           p.cash + coalesce((select sum(h.qty * s.price) from holdings h join stocks s on s.symbol = h.symbol where h.user_id = p.id), 0) as total
    from profiles p where p.role = 'customer'
  )
  select t.name, t.total,
         (t.total / nullif((select start_cash from settings where id = 1), 0) - 1) * 100,
         (t.id = auth.uid())
  from t order by t.total desc limit 100
$body$;

-- ---------- admin tools ----------
create or replace function admin_reset_user(p_user uuid) returns void language plpgsql security definer set search_path = public as $body$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  delete from trades where user_id = p_user;
  delete from holdings where user_id = p_user;
  update profiles set cash = (select start_cash from settings where id = 1) where id = p_user;
end
$body$;

create or replace function admin_reset_all() returns void language plpgsql security definer set search_path = public as $body$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  delete from trades where user_id in (select id from profiles where role = 'customer');
  delete from holdings where user_id in (select id from profiles where role = 'customer');
  update profiles set cash = (select start_cash from settings where id = 1) where role = 'customer';
end
$body$;

create or replace function admin_set_cash(p_user uuid, p_cash numeric) returns void language plpgsql security definer set search_path = public as $body$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_cash < 0 then raise exception 'Cash cannot be negative'; end if;
  update profiles set cash = p_cash where id = p_user;
end
$body$;

create or replace function admin_set_role(p_user uuid, p_role text) returns void language plpgsql security definer set search_path = public as $body$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_role not in ('admin','customer') then raise exception 'Bad role'; end if;
  if p_user = auth.uid() and p_role <> 'admin' then raise exception 'You cannot remove your own admin role'; end if;
  update profiles set role = p_role where id = p_user;
end
$body$;

create or replace function admin_new_day() returns void language plpgsql security definer set search_path = public as $body$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  update stocks set prev_close = price;
end
$body$;

-- only logged-in users may call these
revoke all on function place_order(text, text, int) from public, anon;
revoke all on function leaderboard() from public, anon;
revoke all on function admin_reset_user(uuid) from public, anon;
revoke all on function admin_reset_all() from public, anon;
revoke all on function admin_set_cash(uuid, numeric) from public, anon;
revoke all on function admin_set_role(uuid, text) from public, anon;
revoke all on function admin_new_day() from public, anon;
grant execute on function place_order(text, text, int) to authenticated;
grant execute on function leaderboard() to authenticated;
grant execute on function admin_reset_user(uuid) to authenticated;
grant execute on function admin_reset_all() to authenticated;
grant execute on function admin_set_cash(uuid, numeric) to authenticated;
grant execute on function admin_set_role(uuid, text) to authenticated;
grant execute on function admin_new_day() to authenticated;

-- ---------- row level security ----------
alter table settings      enable row level security;
alter table profiles      enable row level security;
alter table stocks        enable row level security;
alter table price_history enable row level security;
alter table holdings      enable row level security;
alter table trades        enable row level security;

drop policy if exists "read settings" on settings;
drop policy if exists "admin write settings" on settings;
drop policy if exists "read own profile" on profiles;
drop policy if exists "read stocks" on stocks;
drop policy if exists "admin write stocks" on stocks;
drop policy if exists "read history" on price_history;
drop policy if exists "read own holdings" on holdings;
drop policy if exists "read own trades" on trades;

create policy "read settings"  on settings for select to authenticated using (true);
create policy "admin write settings" on settings for update to authenticated using (is_admin()) with check (is_admin());
create policy "read own profile" on profiles for select to authenticated using (id = auth.uid() or is_admin());
create policy "read stocks"    on stocks for select to authenticated using (true);
create policy "admin write stocks" on stocks for all to authenticated using (is_admin()) with check (is_admin());
create policy "read history"   on price_history for select to authenticated using (true);
create policy "read own holdings" on holdings for select to authenticated using (user_id = auth.uid() or is_admin());
create policy "read own trades"   on trades for select to authenticated using (user_id = auth.uid() or is_admin());
-- no insert/update/delete policies on profiles, holdings, trades: nobody can edit them directly, only the functions above

-- ---------- live updates ----------
do $do$
begin
  alter publication supabase_realtime add table stocks;
exception when duplicate_object then null;
end
$do$;
do $do$
begin
  alter publication supabase_realtime add table settings;
exception when duplicate_object then null;
end
$do$;

-- ============================================================
-- AFTER you sign up in the app, make yourself the first admin:
--   update profiles set role = 'admin' where email = 'YOUR-EMAIL@example.com';
-- ============================================================
