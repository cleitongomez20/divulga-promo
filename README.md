# Divulga Promo

Você vai construir um SaaS web, em português do Brasil com nome de Divulga Promo, que automatiza a divulgação de links de afiliado da Shopee no Instagram. O sistema:
1. conecta à conta de afiliado Shopee do usuário via API;
2. busca produtos por critérios configuráveis;
3. gera link de afiliado rastreável;
4. gera um vídeo curto vertical a partir das imagens e dos dados do produto;
5. publica no Instagram como Reel e Story, em modo manual assistido ou automático;
6. responde a comentários com palavra-gatilho enviando o link por mensagem;
7. mostra um painel com cliques, pedidos e comissões.
Objetivo estratégico: gerar volume de cliques para marcar o maior número possível de pessoas com o cookie de afiliado da Shopee, válido por 7 dias. Por isso a seleção de produtos prioriza os que atraem clique (muitas vendas, boa avaliação, preço acessível), e não apenas o maior percentual de comissão.
A2. Público e experiência
Mulheres donas de casa, iniciantes ou intermediárias, sem tempo para pesquisar produtos, montar templates e editar vídeos.
• Mobile-first, linguagem simples e acolhedora. Evite jargão (ROI, UTM, sub ID). Mostre “quanto você ganhou”, “quantas pessoas clicaram”, “o que foi postado hoje”.
• Poucos passos, estados vazios explicativos, alertas dizendo claramente o que fazer.
• Padrão simples por nicho, com um modo avançado que expõe os filtros detalhados.
• Referência de experiência: a UTMfy (tudo em um só lugar, login simples, painel claro). Use como inspiração, sem copiar.
A3. Fases
• Fase 1 (agora): uso próprio, um único usuário (o dono), com o banco já preparado para vários usuários.
• Fase 2: cadastro de clientes, cobrança e acesso pela Hotmart, onboarding guiado, planos e limites, verificação do app na Meta.
• Fase 3: premium (mais contas de Instagram, clipes por IA, narração, música), Kiwify, Braip, Cakto, Amazon e Mercado Livre, Facebook.
Na Fase 1 NÃO construa: cadastro público, cobrança, Facebook, música, narração, outros marketplaces.
A4. Stack e arquitetura
• Front: React + TypeScript + Tailwind + shadcn/ui, gráficos com Recharts.
• Backend: Supabase próprio (Postgres, Auth, Storage, Edge Functions, pg_cron). Toda chamada à Shopee, à Meta, ao serviço de render e à IA de texto acontece em Edge Functions, nunca no navegador.
• Jobs em segundo plano: fila em tabela (posts) processada por pg_cron e Edge Functions.
• Conectores com interface única e implementações trocáveis:
    ◦ MarketplaceConnector (Shopee agora; Amazon e Mercado Livre depois): searchProducts, getProduct, generateLink, getConversions.
    ◦ RenderProvider (serviço de render pronto por API agora; worker próprio depois): recebe imagens, textos e template, devolve vídeo 9:16.
    ◦ BillingProvider (Hotmart na Fase 2; Kiwify, Braip e Cakto depois): recebe webhooks e traduz para eventos internos.
    ◦ TextAIProvider: geração de legendas e textos.
• Multi-tenant desde o início: todo dado pertence a um user_id; todo conteúdo pertence também a um instagram_account_id. Mesmo com um só usuário na Fase 1.
• Fuso padrão America/Sao_Paulo, configurável por conta.
A5. Modelo de dados (resumo)
Crie as tabelas abaixo, todas com RLS ativa. Ajuste nomes e tipos como achar melhor, mantendo as relações.
• profiles (id = auth.users.id, nome, fuso, criado_em).
• user_roles (user_id, role: admin | user). Tabela separada, que o usuário não consegue editar.
• marketplace_connections (user_id, marketplace, status, referência de credencial criptografada, última sincronização). Credenciais só acessíveis pelo servidor.
• instagram_accounts (user_id, ig_user_id, username, page_id, referência do token criptografado, expiração do token, status, limite diário, estado de aquecimento, fuso).
• search_profiles (user_id, nome, filtros em JSON: comissão mínima, faixa de preço, mínimo de vendas, nota mínima, categorias, mínimo de imagens; modo manual ou automático; posts por dia; janelas de horário).
• products (marketplace, id externo, título, preço, comissão, vendas, nota, categoria, imagens, url, data da coleta, score de potencial de clique).
• posts (instagram_account_id, product_id, search_profile_id, formato reel | story, status, agendado_para, publicado_em, video_asset_id, legenda, palavra_gatilho, link_afiliado, sub_id, ig_media_id, post_pai_id para ligar Story ao Reel, tentativas, erro). Status: rascunho, na fila, renderizando, pronto, publicando, publicado, falhou, ignorado.
• video_assets (caminho no Storage, duração, id do job no provedor, template).
• comment_events (post_id, id do comentário, id do autor, status, enviado_em). Guardar o mínimo necessário e deduplicar por comentário.
• bio_pages e bio_links (slug, instagram_account_id, itens exibidos) e click_events (link, post, data, hash do agente de usuário, flag de robô). Não guardar IP em texto puro.
• orders (id do pedido, sub_id, status pendente | concluído | cancelado, comissão, produto, data) e metrics_daily (agregados por dia, post, produto e template).
• activity_log (quem, o quê, quando, resultado). Visível no painel.
• Estrutura mínima para o futuro (sem uso na Fase 1): plans, subscriptions, entitlements.
A6. Regras de publicação
Valores padrão sugeridos, todos configuráveis:
• 3 produtos por dia. Cada produto gera um Reel e, depois, um Story do mesmo produto.
• Janela de horário ativa: 08h às 22h no fuso da conta. Horários sorteados dentro da janela, nunca fixos.
• Intervalo mínimo entre quaisquer postagens: 45 minutos.
• Story depois do Reel: só entra na fila após o Reel ser publicado com sucesso, com atraso aleatório entre 1 e 8 horas, e sempre no mesmo dia (o Story dura 24 horas). Se o Reel falhar, o Story daquele produto não sai.
• Story = versão curta (teaser) do mesmo conteúdo, com texto direcionando ao Reel. Não depender de sticker de link, que a API não controla.
• Limite diário por conta, configurável, nunca ultrapassado.
• Aquecimento para conta nova: dias 1 a 3 com 1 publicação por dia, dias 4 a 7 com 2, depois o limite configurado. A usuária vê uma explicação clara do motivo.
• Não repetir o mesmo produto em menos de 14 dias.
• Revalidar antes de publicar: preço, estoque e nota. Se o produto deixou de atender ao perfil, trocar por outro que atenda.
• Falhas: até 3 tentativas com intervalo crescente, sem postar duplicado (use chave de idempotência). Conexão expirada pausa a fila e avisa o que fazer. Limite ou erro de excesso da Meta encerra o dia e retoma no seguinte. Tudo registrado no activity_log.
• Modo manual: o sistema entrega o pacote pronto (vídeo, legenda, link, palavra-gatilho) para a usuária baixar, copiar e postar pelo app, com um aviso de que ela pode escolher uma música em alta na hora.
• Modo automático: o mesmo fluxo, agendado e publicado sem intervenção, respeitando todas as regras acima.
A7. Regras de conteúdo
• Vídeo: vertical 9:16, de 15 a 30 segundos, somente imagens e textos (sem narração e sem música na Fase 1). Estrutura: gancho (0 a 3 s), demonstração com 3 a 5 imagens e textos curtos de benefício, chamada final (“comente EU QUERO” e/ou “link na bio”). Fonte grande, contraste alto, texto dentro da área segura do Reels.
• Mínimo de imagens: produtos com menos de 3 imagens de boa qualidade são descartados pelo filtro.
• Fonte do vídeo: apenas imagens e dados do produto vindos da API. A interface de mídia deve ser genérica (imagens do produto, vídeo enviado pelo usuário no futuro), sem baixar vídeos de terceiros.
• Legendas e textos: gerados por IA a partir dos dados reais da página do produto. Tom simpático e próximo, como uma amiga indicando.
    ◦ Permitido: linguagem de descoberta e indicação (“olha o que eu encontrei”, “achei super prático”, “olha esse detalhe”).
    ◦ Proibido: afirmar uso pessoal, resultado ou depoimento (“comprei e amei”, “uso todo dia”, “resolveu meu problema”); inventar benefício ou funcionalidade que não esteja na página; promessa de ganho; preço fixo (use “confira o valor atual”); superlativos que não dá para comprovar.
    ◦ Obrigatório: estrutura gancho, benefício e chamada; indicação de que é divulgação com link de afiliado; 5 a 8 hashtags do nicho; variação entre postagens (abertura, palavra-gatilho, hashtags).
• Palavra-gatilho: uma por post, variada entre posts.
A8. Segurança (obrigatória em todo o projeto)
Itens essenciais já na Fase 1:
• HTTPS/TLS em tudo, com HSTS e redirecionamento forçado no domínio próprio.
• RLS ativa em todas as tabelas e buckets, sem exceção, com políticas por user_id. Tabelas de credenciais e tokens sem nenhum acesso pelo navegador.
• Rate limiting nos endpoints públicos: redirecionador do link na bio, webhooks e login.
• RBAC mínimo: papéis em user_roles, checados no servidor. Papel (admin ou usuário) é diferente de plano (limites comprados).
• 2FA por aplicativo autenticador disponível e ativado para o admin.
• CSP básica e sanitização de todo texto vindo de fora (comentários, títulos de produto), para evitar XSS.
• Validação do parâmetro state em todo login OAuth (Meta). É o que importa de CSRF nesta arquitetura, já que a autenticação usa token no cabeçalho e não cookie automático.
Fase 2 ou quando o hosting permitir: cabeçalhos HTTP de segurança completos (HSTS, proteção contra clickjacking, tipo de conteúdo, política de referência), CSP reforçada, 2FA opcional para clientes.
Outras regras obrigatórias:
1. Tokens e credenciais (Shopee e Instagram) criptografados no servidor, nunca expostos no código do navegador. Renovação automática do token do Instagram antes de expirar.
2. A chave de serviço do Supabase nunca vai para o front.
3. Webhooks (Meta e, na Fase 2, Hotmart) só são aceitos com assinatura ou token validado, e processados de forma idempotente.
4. O redirecionador do link na bio só aponta para domínios permitidos (Shopee), para não virar redirecionador aberto.
5. Vídeos no Storage acessados por link temporário assinado, apagados depois da publicação.
6. Validação de todas as entradas no servidor.
7. Registro de auditoria (activity_log) e backups do banco.
8. Antes de publicar cada passo, rodar a verificação de segurança disponível no Lovable e corrigir o que ela apontar.
A9. Como você deve trabalhar
• Construa um passo por vez, na ordem da Parte B, e pare ao final de cada um para eu testar.
• Não invente detalhes de API. Consulte a documentação oficial da Shopee Affiliate Open Platform e da Meta (Instagram Graph API, comentários, mensagens). Onde faltar credencial ou a documentação for incerta, use mock atrás da mesma interface e me avise.
• Se algo mudar a arquitetura ou o escopo, pergunte antes de decidir.
• Mensagens de erro e textos de interface em português simples.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/ba5c44b6-933f-43ca-b6a0-2523102cbff8).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
