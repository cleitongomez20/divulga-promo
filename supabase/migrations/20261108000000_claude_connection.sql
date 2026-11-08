-- B4a: conexão com a API do Claude, contador de gasto e ajuste de permissões da tabela post_media.
-- Já executado manualmente no Supabase; este arquivo apenas documenta e pode ser repetido sem efeitos colaterais.

create table if not exists public.ai_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  provider text not null default 'anthropic',
  credential_id uuid references public.connector_secrets(id) on delete set null,
  status text not null default 'connected',
  model text not null default 'claude-sonnet-5-5',
  monthly_cap_cents integer not null default 1000,
  last_tested_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_connections_cap_range check (monthly_cap_cents between 100 and 1000000)
);

create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  purpose text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_micros bigint not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_user_created_idx on public.ai_usage (user_id, created_at desc);

-- O navegador só lê; quem escreve é o servidor (mesmo padrão das outras tabelas).
grant select on public.ai_connections to authenticated;
grant all on public.ai_connections to service_role;
grant select on public.ai_usage to authenticated;
grant all on public.ai_usage to service_role;

alter table public.ai_connections enable row level security;
alter table public.ai_usage enable row level security;

drop policy if exists ai_connections_read on public.ai_connections;
create policy ai_connections_read on public.ai_connections for select to authenticated
  using (user_id = auth.uid() and public.private_access());
drop policy if exists ai_usage_read on public.ai_usage;
create policy ai_usage_read on public.ai_usage for select to authenticated
  using (user_id = auth.uid() and public.private_access());

drop trigger if exists touch_updated on public.ai_connections;
create trigger touch_updated before update on public.ai_connections
  for each row execute function public.touch_updated_at();

-- Ajuste da etapa anterior: o servidor precisa de permissão explícita na tabela post_media.
grant select on public.post_media to authenticated;
grant all on public.post_media to service_role;