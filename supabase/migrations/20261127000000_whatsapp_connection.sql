-- W2: conexão do WhatsApp por QR code (Evolution API). Uma conexão por usuário.
-- O navegador só lê; quem escreve é o servidor (mesmo padrão das outras tabelas).
-- Pode ser executado mais de uma vez sem efeitos colaterais.

create table if not exists public.whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  instance_name text not null,
  status text not null default 'waiting_qr',
  phone text,
  profile_name text,
  connected_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_connections_status check (status in ('waiting_qr', 'connected', 'disconnected'))
);

grant select on public.whatsapp_connections to authenticated;
grant all on public.whatsapp_connections to service_role;

alter table public.whatsapp_connections enable row level security;

drop policy if exists whatsapp_connections_read on public.whatsapp_connections;
create policy whatsapp_connections_read on public.whatsapp_connections for select to authenticated
  using (user_id = auth.uid() and public.private_access());

drop trigger if exists touch_updated on public.whatsapp_connections;
create trigger touch_updated before update on public.whatsapp_connections
  for each row execute function public.touch_updated_at();
