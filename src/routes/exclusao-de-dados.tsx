import { createFileRoute } from '@tanstack/react-router';
import { pageHead } from '@/lib/metadata';
import { CONTACT_EMAIL, DELETION_DAYS, POLICY_UPDATED, SITE_NAME } from '@/lib/legal';
import { Bullets, LegalPage, Section } from '@/components/legal-page';

export const Route = createFileRoute('/exclusao-de-dados')({
  head: () => pageHead('Exclusão de dados', 'Como cortar o acesso do Divulga Promo ao seu Instagram e como pedir a exclusão dos seus dados.'),
  component: DataDeletion,
});

const subject = encodeURIComponent('Exclusão de dados');
const body = encodeURIComponent('Quero excluir meus dados do Divulga Promo.\n\nE-mail da conta:\nUsuário do Instagram (@):\n');

function DataDeletion() {
  return <LegalPage title="Exclusão de dados" updated={POLICY_UPDATED}
    intro={<>Aqui você vê como cortar o acesso do {SITE_NAME} ao seu Instagram e como pedir que apaguemos os seus dados. Você pode fazer só o primeiro passo, se quiser apenas desconectar.</>}>

    <Section id="desconectar" title="1. Desconectar o Instagram">
      <p>Isso faz o aplicativo parar de publicar e de responder comentários na sua conta.</p>
      <Bullets items={[
        <>No aplicativo: entre na sua conta, abra <strong>Conexões</strong> e use a opção de desconectar a conta do Instagram. As chaves de acesso guardadas são apagadas.</>,
        <>Na Meta: abra as configurações da sua conta do Instagram ou do Facebook, entre em <strong>Apps e sites</strong> (ou <strong>Integrações comerciais</strong>) e remova o {SITE_NAME}. Os nomes dos menus podem mudar, e a Meta mostra o caminho atual na própria ajuda.</>,
      ]} />
    </Section>

    <Section id="pedir" title="2. Pedir a exclusão dos seus dados">
      <p>Envie um e-mail para <a className="font-medium text-primary underline" href={`mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`}>{CONTACT_EMAIL}</a> com o assunto <strong>Exclusão de dados</strong>, escrevendo:</p>
      <Bullets items={[
        'o e-mail que você usa na sua conta do ' + SITE_NAME + ';',
        'o seu usuário do Instagram (@), se tiver conectado.',
      ]} />
      <p>Podemos pedir uma confirmação, respondendo ao e-mail da conta, para ter certeza de que o pedido é seu. Apagamos em até {DELETION_DAYS} dias e avisamos quando terminar.</p>
    </Section>

    <Section id="apagado" title="3. O que é apagado">
      <Bullets items={[
        'sua conta, seu nome e seu e-mail;',
        'as chaves de acesso do Instagram, do Facebook, da Shopee e dos serviços de inteligência artificial e vídeo;',
        'as informações da conexão com o Instagram e com a Página do Facebook;',
        'suas publicações, produtos, vídeos e links de afiliado guardados no aplicativo;',
        'os registros de comentários atendidos, incluindo o identificador e o nome de usuário de quem comentou;',
        'o histórico de atividades.',
      ]} />
      <p>Isso não apaga o que já foi publicado no seu Instagram. Para remover as publicações, apague-as no próprio Instagram.</p>
    </Section>

    <Section id="mantido" title="4. O que pode ser mantido">
      <p>Podemos manter, só pelo tempo necessário, registros que a lei obrigue a guardar ou que sirvam para nos defender em um processo, e cópias de segurança até serem substituídas no ciclo normal do serviço.</p>
    </Section>

    <Section id="comentou" title="5. Se você só comentou numa publicação">
      <p>Se você comentou numa publicação divulgada por um usuário do {SITE_NAME} e quer que o seu nome de usuário seja apagado dos nossos registros, envie o pedido para o mesmo e-mail, informando o seu @ do Instagram.</p>
    </Section>

    <Section id="mais" title="6. Mais informações">
      <p>Veja também a <a className="font-medium text-primary underline" href="/privacidade">política de privacidade</a>.</p>
    </Section>
  </LegalPage>;
}
