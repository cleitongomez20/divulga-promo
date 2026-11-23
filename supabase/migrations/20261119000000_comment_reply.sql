-- B6: resposta automática "EU QUERO". Quando alguém comenta a palavra-gatilho num post publicado, o link do produto é enviado por mensagem privada.
-- Já executado manualmente no Supabase; este arquivo apenas documenta e pode ser repetido sem efeitos colaterais.

create table if not exists public.comment_reply_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  enabled boolean not null default false,
  template text,
  last_message text,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- O navegador só lê; quem escreve é o servidor (mesmo padrão das outras tabelas).
grant select on public.comment_reply_settings to authenticated;
grant all on public.comment_reply_settings to service_role;
alter table public.comment_reply_settings enable row level security;
drop policy if exists comment_reply_settings_read on public.comment_reply_settings;
create policy comment_reply_settings_read on public.comment_reply_settings for select to authenticated
  using (user_id = auth.uid() and public.private_access());
drop trigger if exists touch_updated on public.comment_reply_settings;
create trigger touch_updated before update on public.comment_reply_settings
  for each row execute function public.touch_updated_at();

-- A fila de comentários: o que aconteceu com cada um, e quantas vezes o envio foi tentado.
alter table public.comment_events
  add column if not exists error text,
  add column if not exists attempts integer not null default 0,
  add column if not exists author_username text,
  add column if not exists commented_at timestamptz,
  add column if not exists message_id text;

create index if not exists comment_events_queue_idx
  on public.comment_events (status, created_at)
  where status in ('detected', 'sending');
