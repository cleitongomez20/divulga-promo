-- B4d: vídeos de Reels e Story criados com o Higgsfield. Guarda o pedido enquanto o vídeo está sendo gerado (status "rendering").
-- Já executado manualmente no Supabase; este arquivo apenas documenta e pode ser repetido sem efeitos colaterais.

alter table public.posts
  add column if not exists video_job jsonb;

create index if not exists posts_rendering_idx
  on public.posts (created_at)
  where status = 'rendering';
