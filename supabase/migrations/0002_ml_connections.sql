-- Stores each buyer's Mercado Livre OAuth connection, created via the
-- "Conectar Mercado Livre" button in the painel (Integrações page).
create table if not exists public.ml_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ml_user_id text not null,
  ml_nickname text,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

alter table public.ml_connections enable row level security;

-- Only the service role (used by the ml-callback function) can write.
create policy "service role full access"
  on public.ml_connections
  for all
  to service_role
  using (true)
  with check (true);

-- Buyers can read their own connection (e.g. to show "Conectado" on the UI).
create policy "users read own connection"
  on public.ml_connections
  for select
  to authenticated
  using (auth.uid() = user_id);
