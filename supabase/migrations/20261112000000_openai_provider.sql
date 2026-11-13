-- Troca de IA, passo 1: conexão com a OpenAI, contador de gasto da OpenAI e a escolha de qual IA está ativa.
-- O Claude não é tocado: continua com as próprias tabelas (ai_connections e ai_usage) e continua sendo a IA ativa até você trocar.
-- Para rodar manualmente no Supabase (SQL Editor); pode ser repetido sem efeitos colaterais.

-- Conexão com a OpenAI. monthly_cap_cents vazio (null) significa "sem limite de gasto".
create table if not exists public.openai_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  provider text not null default 'openai',
  credential_id uuid references public.connector_secrets(id) on delete set null,
  status text not null default 'connected',
  model text not null default 'gpt-6.1-terra',
  monthly_cap_cents integer,
  last_tested_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint openai_connections_cap_range check (monthly_cap_cents is null or monthly_cap_cents between 100 and 1000000)
);

-- Uso da OpenAI (tokens e custo estimado), separado do uso do Claude para que cada teto conte só o gasto da própria IA.
create table if not exists public.openai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  purpose text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_micros bigint not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists openai_usage_user_created_idx on public.openai_usage (user_id, created_at desc);

-- Qual IA cria o conteúdo. Sem linha nesta tabela, vale o Claude.
create table if not exists public.ai_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  active_provider text not null default 'anthropic',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_settings_provider_valid check (active_provider in ('anthropic', 'openai'))
);

-- O navegador só lê; quem escreve é o servidor (mesmo padrão das outras tabelas).
grant select on public.openai_connections to authenticated;
grant all on public.openai_connections to service_role;
grant select on public.openai_usage to authenticated;
grant all on public.openai_usage to service_role;
grant select on public.ai_settings to authenticated;
grant all on public.ai_settings to service_role;

alter table public.openai_connections enable row level security;
alter table public.openai_usage enable row level security;
alter table public.ai_settings enable row level security;

drop policy if exists openai_connections_read on public.openai_connections;
create policy openai_connections_read on public.openai_connections for select to authenticated
  using (user_id = auth.uid() and public.private_access());
drop policy if exists openai_usage_read on public.openai_usage;
create policy openai_usage_read on public.openai_usage for select to authenticated
  using (user_id = auth.uid() and public.private_access());
drop policy if exists ai_settings_read on public.ai_settings;
create policy ai_settings_read on public.ai_settings for select to authenticated
  using (user_id = auth.uid() and public.private_access());

drop trigger if exists touch_updated on public.openai_connections;
create trigger touch_updated before update on public.openai_connections
  for each row execute function public.touch_updated_at();
drop trigger if exists touch_updated on public.ai_settings;
create trigger touch_updated before update on public.ai_settings
  for each row execute function public.touch_updated_at();