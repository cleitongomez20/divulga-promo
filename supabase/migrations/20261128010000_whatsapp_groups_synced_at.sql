-- Guarda quando os grupos foram buscados pela última vez, para o app atualizar sozinho sem botão.
-- Pode ser executado mais de uma vez sem efeitos colaterais.
alter table public.whatsapp_connections add column if not exists groups_synced_at timestamptz;
