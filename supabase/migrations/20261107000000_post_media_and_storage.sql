-- B3b passo 1: espaço de armazenamento de mídia, suporte a fotos e ligação de arquivos às publicações (carrossel).
-- Já executado manualmente no Supabase; este arquivo apenas documenta e permite repetir sem efeitos colaterais.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 52428800, array['image/jpeg','video/mp4','video/quicktime'])
on conflict (id) do nothing;

drop policy if exists "media_upload_own_folder" on storage.objects;
create policy "media_upload_own_folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "media_select_own_folder" on storage.objects;
create policy "media_select_own_folder" on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "media_delete_own_folder" on storage.objects;
create policy "media_delete_own_folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

alter table public.video_assets
  add column if not exists media_type text not null default 'video',
  add column if not exists mime_type text,
  add column if not exists size_bytes bigint,
  add column if not exists source text not null default 'manual';

create table if not exists public.post_media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  post_id uuid not null references public.posts(id) on delete cascade,
  asset_id uuid not null references public.video_assets(id) on delete cascade,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (post_id, position)
);

create index if not exists post_media_post_id_idx on public.post_media(post_id);

alter table public.post_media enable row level security;

drop policy if exists "post_media_own" on public.post_media;
create policy "post_media_own" on public.post_media
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());