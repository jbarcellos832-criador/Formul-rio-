-- Tracks processed Perfect Pay purchases so the webhook never creates
-- duplicate accounts or sends the welcome e-mail twice for the same sale.
create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  perfectpay_order_id text unique not null,
  customer_email text not null,
  customer_name text,
  plan text,
  status text not null,
  created_at timestamptz not null default now()
);

alter table public.purchases enable row level security;

-- Only the service role (used by the webhook function) can read/write this
-- table. No public/anon access is granted.
create policy "service role full access"
  on public.purchases
  for all
  to service_role
  using (true)
  with check (true);
