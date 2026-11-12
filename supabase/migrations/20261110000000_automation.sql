-- B4e: automação (modo automático). Guarda se está ligada, o modo (aprovação ou totalmente automático), o Story do mesmo vídeo e a mensagem de status.
-- Já executado manualmente no Supabase; este arquivo apenas documenta e pode ser repetido sem efeitos colaterais.

create table if not exists public.automation_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  enabled boolean not null default false,
  mode text not null default 'approval',
  story_after_reel boolean not null default true,
  last_message text,
  last_run_at timestamptz,
  retry_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_mode_valid check (mode in ('approval', 'auto'))
);

-- O navegador só lê; quem escreve é o servidor (mesmo padrão das outras tabelas).
grant select on public.automation_settings to authenticated;
grant all on public.automation_settings to service_role;

alter table public.automation_settings enable row level security;
drop policy if exists automation_settings_read on public.automation_settings;
create policy automation_settings_read on public.automation_settings for select to authenticated
  using (user_id = auth.uid() and public.private_access());

drop trigger if exists touch_updated on public.automation_settings;
create trigger touch_updated before update on public.automation_settings
  for each row execute function public.touch_updated_at();