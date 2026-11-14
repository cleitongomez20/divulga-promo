-- Opção "Personagem falando" da automação e do botão "Gerar conteúdo com a IA": ligada, a IA cria um personagem que fala nos vídeos;
-- desligada, os vídeos saem sem fala. Para rodar manualmente no Supabase (SQL Editor); pode ser repetido sem efeitos colaterais.

alter table public.automation_settings add column if not exists storyboard_speech boolean not null default true;