-- B4c passo 1: conexão com o Higgsfield (imagens e vídeos) e contador de gasto estimado.
-- Já executado manualmente no Supabase; este arquivo apenas documenta e pode ser repetido sem efeitos colaterais.

create table if not exists public.media_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  provider text not null default 'higgsfield',
  credential_id uuid references public.connector_secrets(id) on delete set null,
  status text not null default 'connected',
  monthly_cap_cents integer not null default 1000,
  last_tested_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint media_connections_cap_range check (monthly_cap_cents between 100 and 1000000)
);

create table if not exists public.media_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  purpose text not null,
  model text not null,
  cost_micros bigint not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists media_usage_user_created_idx on public.media_usage (user_id, created_at desc);

-- O navegador só lê; quem escreve é o servidor (mesmo padrão das outras tabelas).
grant select on public.media_connections to authenticated;
grant all on public.media_connections to service_role;
grant select on public.media_usage to authenticated;
grant all on public.media_usage to service_role;

alter table public.media_connections enable row level security;
alter table public.media_usage enable row level security;

drop policy if exists media_connections_read on public.media_connections;
create policy media_connections_read on public.media_connections for select to authenticated
  using (user_id = auth.uid() and public.private_access());
drop policy if exists media_usage_read on public.media_usage;
create policy media_usage_read on public.media_usage for select to authenticated
  using (user_id = auth.uid() and public.private_access());

drop trigger if exists touch_updated on public.media_connections;
create trigger touch_updated before update on public.media_connections
  for each row execute function public.touch_updated_at();