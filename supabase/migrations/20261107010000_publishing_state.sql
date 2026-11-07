-- B3b passo 3 e 4: estado da publicação entre as visitas do agendador, e índice para achar rápido o que está na hora.
-- Já executado manualmente no Supabase; este arquivo apenas documenta e pode ser repetido sem efeitos colaterais.

alter table public.posts
  add column if not exists publish_state jsonb;

create index if not exists posts_due_idx
  on public.posts (status, scheduled_at)
  where status in ('scheduled', 'publishing');