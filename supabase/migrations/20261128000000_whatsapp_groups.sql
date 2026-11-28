-- W3: grupos do WhatsApp e as regras de envio de cada um (categoria, dias, horário e intervalo).
-- O navegador só lê; quem escreve é o servidor. Pode ser executado mais de uma vez sem efeitos colaterais.

create table if not exists public.whatsapp_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  group_jid text not null,
  name text not null,
  size integer,
  present boolean not null default true,
  enabled boolean not null default false,
  category_id bigint,
  keyword text not null default '',
  days_of_week smallint[] not null default '{1,2,3,4,5,6,7}',
  window_start text not null default '06:00',
  window_end text not null default '22:00',
  interval_minutes smallint not null default 30,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_groups_unique unique (user_id, group_jid),
  constraint whatsapp_groups_interval check (interval_minutes between 5 and 60),
  constraint whatsapp_groups_days check (array_length(days_of_week, 1) between 1 and 7 and days_of_week <@ array[1,2,3,4,5,6,7]::smallint[]),
  constraint whatsapp_groups_window check (window_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and window_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and window_start < window_end)
);
create index if not exists whatsapp_groups_user_idx on public.whatsapp_groups (user_id, present, name);

grant select on public.whatsapp_groups to authenticated;
grant all on public.whatsapp_groups to service_role;

alter table public.whatsapp_groups enable row level security;

drop policy if exists whatsapp_groups_read on public.whatsapp_groups;
create policy whatsapp_groups_read on public.whatsapp_groups for select to authenticated
  using (user_id = auth.uid() and public.private_access());

drop trigger if exists touch_updated on public.whatsapp_groups;
create trigger touch_updated before update on public.whatsapp_groups
  for each row execute function public.touch_updated_at();
