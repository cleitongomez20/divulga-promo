-- Teto de gasto opcional: vazio (null) significa "sem limite". O Claude e o Higgsfield passam a aceitar a conexão sem teto.
-- Os valores já salvos continuam como estão até você apagar o teto na tela Conexões.
-- Para rodar manualmente no Supabase (SQL Editor); pode ser repetido sem efeitos colaterais.
-- A regra "entre 100 e 1000000 centavos" continua valendo para quem preencher um teto (um valor vazio passa na regra).

alter table public.ai_connections alter column monthly_cap_cents drop not null;
alter table public.media_connections alter column monthly_cap_cents drop not null;