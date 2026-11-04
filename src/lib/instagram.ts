import { z } from 'zod';

export const CALLBACK_PATH = '/api/public/instagram-callback';
export const GRAPH_VERSION = 'v25.0';
// What the login configuration on the Meta side has to grant for publishing to work.
export const REQUIRED_PERMISSIONS = ['instagram_basic', 'instagram_content_publish', 'pages_show_list'] as const;

export const instagramAppSchema = z.object({
  appId: z.string().trim().regex(/^\d{8,20}$/, 'O ID do app deve conter apenas números.'),
  appSecret: z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, 'O segredo do app deve ter apenas letras e números (de 16 a 64 caracteres).'),
  configId: z.string().trim().regex(/^\d{8,25}$/, 'O ID da configuração de login deve conter apenas números.'),
});

export type InstagramErrorCode = 'negado' | 'estado' | 'app' | 'troca' | 'permissao' | 'sem_instagram' | 'perfil' | 'expirado' | 'salvar';
const MESSAGES: Record<InstagramErrorCode, string> = {
  negado: 'Você cancelou a autorização. Se quiser, tente de novo.',
  estado: 'O pedido de conexão expirou ou não é válido. Clique em Conectar Instagram de novo.',
  app: 'Salve primeiro os dados do app da Meta (ID do app, segredo e ID da configuração).',
  troca: 'Não foi possível concluir a conexão. Confira o ID do app, o segredo, o ID da configuração e o endereço de retorno, e tente de novo.',
  permissao: 'A configuração de login não concedeu todas as permissões necessárias (instagram_basic, instagram_content_publish e pages_show_list). Edite a configuração na Meta e conecte de novo.',
  sem_instagram: 'Nenhuma conta do Instagram profissional foi encontrada nas Páginas autorizadas. Confirme que o Instagram está vinculado a uma Página do Facebook que você administra e selecione essa Página e o Instagram na tela de autorização.',
  perfil: 'Não foi possível ler os dados da conta do Instagram agora. Tente de novo.',
  expirado: 'O acesso ao Instagram deixou de valer. Conecte de novo.',
  salvar: 'Não foi possível salvar a conexão. Tente de novo.',
};
export function instagramErrorMessage(code: string | null | undefined) {
  return (code && code in MESSAGES ? MESSAGES[code as InstagramErrorCode] : null) ?? 'Não foi possível conectar o Instagram agora. Tente de novo.';
}

export const maskId = (value: string) => (value.length <= 5 ? '•'.repeat(value.length) : `${value.slice(0, 3)}${'•'.repeat(value.length - 5)}${value.slice(-2)}`);