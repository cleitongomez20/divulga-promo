-- B4b: rascunhos criados pelo Claude. Marca a origem da publicação e guarda o plano do conteúdo (motivo da escolha, ângulo, gancho).
-- Já executado manualmente no Supabase; este arquivo apenas documenta e pode ser repetido sem efeitos colaterais.

alter table public.posts
  add column if not exists source text not null default 'manual',
  add column if not exists ai_plan jsonb;