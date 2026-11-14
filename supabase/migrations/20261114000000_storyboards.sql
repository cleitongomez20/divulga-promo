-- Fase 2 da troca de IA: storyboard de 6 cenas com imagens criadas pela OpenAI a partir da foto real do produto.
-- Cada imagem pronta vira uma linha em video_assets (source = 'ai_image'), igual às outras mídias do app.
-- Para rodar manualmente no Supabase (SQL Editor); pode ser repetido sem efeitos colaterais.

create table if not exists public.storyboards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  instagram_account_id uuid,
  product_id uuid,
  product_title text not null default '',
  status text not null default 'planned',
  with_speech boolean not null default false,
  concept text not null default '',
  presenter text,
  reference_path text,
  plan jsonb,
  image_model text not null default 'gpt-image-2.6-flare',
  cost_micros bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint storyboards_status_valid check (status in ('planned', 'generating', 'ready', 'discarded'))
);
create index if not exists storyboards_user_created_idx on public.storyboards (user_id, created_at desc);

create table if not exists public.storyboard_scenes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  storyboard_id uuid not null references public.storyboards(id) on delete cascade,
  position integer not null,
  title text not null default '',
  shot text not null default '',
  motion text not null default '',
  speech text,
  on_screen_text text,
  status text not null default 'pending',
  asset_id uuid references public.video_assets(id) on delete set null,
  attempts integer not null default 0,
  last_error text,
  cost_micros bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint storyboard_scenes_status_valid check (status in ('pending', 'generating', 'done', 'failed')),
  constraint storyboard_scenes_position_valid check (position between 0 and 11),
  constraint storyboard_scenes_unique_position unique (storyboard_id, position)
);
create index if not exists storyboard_scenes_board_idx on public.storyboard_scenes (storyboard_id, position);

-- O navegador só lê; quem escreve é o servidor (mesmo padrão das outras tabelas).
grant select on public.storyboards to authenticated;
grant all on public.storyboards to service_role;
grant select on public.storyboard_scenes to authenticated;
grant all on public.storyboard_scenes to service_role;

alter table public.storyboards enable row level security;
alter table public.storyboard_scenes enable row level security;

drop policy if exists storyboards_read on public.storyboards;
create policy storyboards_read on public.storyboards for select to authenticated
  using (user_id = auth.uid() and public.private_access());
drop policy if exists storyboard_scenes_read on public.storyboard_scenes;
create policy storyboard_scenes_read on public.storyboard_scenes for select to authenticated
  using (user_id = auth.uid() and public.private_access());

drop trigger if exists touch_updated on public.storyboards;
create trigger touch_updated before update on public.storyboards
  for each row execute function public.touch_updated_at();
drop trigger if exists touch_updated on public.storyboard_scenes;
create trigger touch_updated before update on public.storyboard_scenes
  for each row execute function public.touch_updated_at();