import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/metadata';
import { CONTACT_EMAIL, DELETION_DAYS, POLICY_UPDATED, SITE_NAME } from '@/lib/legal';
import { Bullets, LegalPage, Section } from '@/components/legal-page';

export const Route = createFileRoute('/privacidade')({
  head: () => pageHead('Política de privacidade', 'Como o Divulga Promo coleta, usa, protege e apaga os seus dados, incluindo os dados do Instagram e da Meta.'),
  component: Privacy,
});

function Privacy() {
  return <LegalPage title="Política de privacidade" updated={POLICY_UPDATED}
    intro={<>O {SITE_NAME} ajuda você a divulgar produtos de afiliado: ele monta as publicações, publica no seu Instagram e responde por mensagem privada a quem comenta uma palavra-gatilho. Esta página explica quais dados usamos para isso, com quem eles passam e como você pode apagá-los. Ela segue a Lei Geral de Proteção de Dados (LGPD, Lei 13.709/2018).</>}>

    <Section id="quem-somos" title="1. Quem é o responsável">
      <p>O {SITE_NAME} é o serviço descrito acima. Para qualquer assunto sobre seus dados, escreva para <a className="font-medium text-primary underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
    </Section>

    <Section id="dados" title="2. Quais dados usamos">
      <Bullets items={[
        <><strong>Sua conta:</strong> nome, e-mail, fuso horário e senha. A senha é guardada de forma protegida pelo serviço de autenticação e nós não conseguimos lê-la.</>,
        <><strong>Conexão com o Instagram e o Facebook:</strong> o identificador e o nome de usuário da sua conta profissional do Instagram, o identificador da Página do Facebook ligada a ela e as chaves de acesso (tokens) que a Meta nos entrega quando você conecta. As chaves ficam guardadas com criptografia e só o servidor do aplicativo as usa.</>,
        <><strong>Suas publicações:</strong> legenda, tipo (Reels, Story), data, identificador da publicação no Instagram, produto e link de afiliado.</>,
        <><strong>Comentários nas suas publicações (quando a resposta automática está ligada):</strong> a Meta avisa o aplicativo de cada comentário. Lemos o texto só para verificar se ele contém a palavra-gatilho e <strong>não guardamos o texto</strong>. Guardamos o identificador do comentário, o identificador e o nome de usuário de quem comentou, a data e o resultado do envio da mensagem.</>,
        <><strong>Mensagem privada enviada:</strong> a resposta com o link do produto que o aplicativo manda pelo Instagram a quem comentou.</>,
        <><strong>Produtos e resultados da Shopee:</strong> os produtos que você escolhe e, se você conectar a Shopee, informações dos seus links e das comissões.</>,
        <><strong>Chaves de serviços que você cadastra</strong> (por exemplo Claude, OpenAI e Higgsfield), também guardadas com criptografia.</>,
        <><strong>Histórico de atividades:</strong> um registro do que o aplicativo fez na sua conta, para você acompanhar.</>,
        <><strong>Dados técnicos de acesso</strong> (como endereço IP e navegador), registrados pelos serviços de hospedagem para segurança e funcionamento.</>,
      ]} />
    </Section>

    <Section id="finalidades" title="3. Para que usamos e em que base legal">
      <p>Usamos os dados para criar e publicar suas divulgações, enviar a mensagem com o link a quem comentou, mostrar seus resultados e manter a conta segura. A base legal principal é a execução do serviço que você contratou ao criar a conta. Para segurança e prevenção de abuso usamos o legítimo interesse. Quando a lei exigir o seu consentimento, nós o pedimos de forma clara.</p>
    </Section>

    <Section id="meta" title="4. Dados recebidos da Meta (Instagram e Facebook)">
      <p>Usamos os dados que a Meta entrega apenas para fazer funcionar o que você pediu: publicar no seu Instagram, receber os avisos de comentários das suas publicações e enviar a mensagem privada de resposta.</p>
      <Bullets items={[
        'Não vendemos esses dados e não os usamos para publicidade.',
        'Não os entregamos a terceiros além dos serviços listados na seção 5, que trabalham para nós.',
        'Você pode cortar o acesso a qualquer momento, na tela Conexões do aplicativo ou nas configurações do seu Instagram e do seu Facebook (veja a página de exclusão de dados).',
      ]} />
    </Section>

    <Section id="compartilhamento" title="5. Com quem os dados passam">
      <Bullets items={[
        <><strong>Supabase:</strong> banco de dados e autenticação.</>,
        <><strong>Lovable:</strong> hospedagem do aplicativo.</>,
        <><strong>Meta (Instagram e Facebook):</strong> para publicar, ler comentários e enviar a mensagem privada.</>,
        <><strong>Shopee:</strong> para consultar produtos e resultados dos seus links de afiliado.</>,
        <><strong>Provedores de inteligência artificial e vídeo (Anthropic, OpenAI, Higgsfield):</strong> só se você cadastrar a sua chave. Quando você usa esses recursos, textos e imagens do produto são enviados a eles para gerar legendas ou vídeos.</>,
        <><strong>Google Fonts:</strong> a fonte das telas é carregada do Google, que recebe o endereço IP do seu navegador nessa hora.</>,
      ]} />
      <p>Também podemos compartilhar dados se uma lei ou uma ordem de autoridade exigir.</p>
    </Section>

    <Section id="cookies" title="6. Cookies e armazenamento no navegador">
      <p>Usamos apenas o que é necessário para o aplicativo funcionar. Não usamos cookies de publicidade nem de análise de audiência.</p>
      <Bullets items={[
        <><strong>Sessão de acesso</strong> (armazenamento local do navegador): mantém você conectado depois do login. Sem ela o aplicativo não funciona.</>,
        <><strong>Estado do menu lateral</strong> (cookie <code>sidebar_state</code>): lembra se o menu está aberto ou fechado.</>,
        <><strong>Aviso de cookies</strong> (armazenamento local): lembra que você já viu o aviso.</>,
      ]} />
      <p>Você pode apagar esses dados nas configurações do navegador, mas será desconectado. Se um dia usarmos cookies que não sejam necessários, vamos pedir a sua escolha antes.</p>
    </Section>

    <Section id="prazo" title="7. Por quanto tempo guardamos">
      <p>Guardamos os dados enquanto a sua conta existir. Quando você pede a exclusão, apagamos em até {DELETION_DAYS} dias, conforme a página de exclusão de dados. Alguns registros podem ser mantidos pelo tempo que a lei exigir ou para nos defender em um processo. Cópias de segurança são substituídas nos ciclos normais do serviço.</p>
    </Section>

    <Section id="direitos" title="8. Seus direitos">
      <p>Pela LGPD você pode pedir:</p>
      <Bullets items={[
        'confirmação de que tratamos dados seus e acesso a eles;',
        'correção de dados incompletos ou errados;',
        'anonimização, bloqueio ou eliminação dos dados desnecessários ou tratados fora da lei;',
        'portabilidade dos dados;',
        'informação sobre com quem compartilhamos;',
        'a retirada de um consentimento que você tenha dado.',
      ]} />
      <p>Escreva para <a className="font-medium text-primary underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. Se não ficar satisfeito, você também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).</p>
      <p><strong>Quem comentou numa publicação:</strong> se você comentou e quer que o seu nome de usuário seja removido dos nossos registros, mande o pedido para o mesmo e-mail, com o seu @ do Instagram.</p>
    </Section>

    <Section id="seguranca" title="9. Segurança">
      <p>Protegemos os dados com conexão segura (HTTPS), criptografia das chaves de acesso, separação entre as contas dos usuários e acesso restrito ao servidor. Nenhum sistema é totalmente livre de risco; se acontecer um incidente que afete você, avisaremos como a lei determina.</p>
    </Section>

    <Section id="menores" title="10. Menores de idade">
      <p>O {SITE_NAME} é para maiores de 18 anos e não é dirigido a crianças.</p>
    </Section>

    <Section id="mudancas" title="11. Mudanças nesta política">
      <p>Se mudarmos esta política, publicamos a nova versão aqui, com a data de atualização no topo. Mudanças importantes serão avisadas no aplicativo ou por e-mail.</p>
    </Section>

    <Section id="contato" title="12. Contato">
      <p><a className="font-medium text-primary underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></p>
    </Section>
  </LegalPage>;
}
