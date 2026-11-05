import { z } from 'zod';

export const CALLBACK_PATH = '/api/public/instagram-callback';
// Public values of the Meta app (not secrets). The return address is always the published one, never a preview address.
export const META_APP_ID = '1621449662157910';
export const META_CONFIG_ID = '1592981445966230';
export const PUBLIC_ORIGIN = 'https://divulga-promo.lovable.app';
export const CALLBACK_URL = `${PUBLIC_ORIGIN}${CALLBACK_PATH}`;
export const GRAPH_VERSION = 'v27.0';
// What the login configuration on the Meta side has to grant for publishing to work.
export const REQUIRED_PERMISSIONS = ['instagram_basic', 'instagram_content_publish'] as const;

export const instagramAppSchema = z.object({
  appId: z.string().trim().regex(/^\d{8,20}$/, 'O ID do app deve conter apenas números.'),
  appSecret: z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, 'O segredo do app deve ter apenas letras e números (de 16 a 64 caracteres).'),
  configId: z.string().trim().regex(/^\d{8,25}$/, 'O ID da configuração de login deve conter apenas números.'),
});

export const instagramSecretSchema = z.object({
  appSecret: instagramAppSchema.shape.appSecret,
});

// The company's own account: token of a portfolio system user. The account id is found by the app; typing it (17 digits starting
// with 17841, not the portfolio asset id) is optional and only a fallback.
export const ownAccountSchema = z.object({
  accessToken: z.string().trim().min(20, 'Cole o token completo do usuário do sistema.').max(2000, 'O token parece grande demais. Confira se colou só o token.').regex(/^\S+$/, 'O token não pode ter espaços ou quebras de linha.'),
  igUserId: z.string().trim().regex(/^(17841\d{10,14})?$/, 'O ID da conta do Instagram tem só números e começa com 17841 (é o ID que aparece no Meta Business Suite, não o do portfólio).').default(''),
});

export type InstagramErrorCode = 'token_sem_conta' | 'conta' | 'negado' | 'estado' | 'app' | 'troca' | 'permissao' | 'sem_instagram' | 'perfil' | 'expirado' | 'salvar';
const MESSAGES: Record<InstagramErrorCode, string> = {
  token_sem_conta: 'Esse token não listou nenhuma conta do Instagram. Confira se a conta foi atribuída ao usuário do sistema junto com o app Divulga Promo, ou informe o ID da conta (começa com 17841) no campo opcional.',
  conta: 'Não foi possível ler essa conta com esse token. Confira se o token foi gerado para o app Divulga Promo, com a conta do Instagram atribuída ao usuário do sistema, e se o ID é o da conta (começa com 17841).',
  negado: 'Você cancelou a autorização. Se quiser, tente de novo.',
  estado: 'O pedido de conexão expirou ou não é válido. Clique em Conectar Instagram de novo.',
  app: 'Salve primeiro a chave secreta do app da Meta.',
  troca: 'Não foi possível concluir a conexão. Confira o ID do app, o segredo, o ID da configuração e o endereço de retorno, e tente de novo.',
  permissao: 'A configuração de login não concedeu todas as permissões necessárias (instagram_basic e instagram_content_publish). Edite a configuração na Meta e conecte de novo.',
  sem_instagram: 'Nenhuma conta do Instagram profissional foi encontrada nesta autorização. Confirme que a conta é profissional (comercial ou criador de conteúdo) e, na tela da Meta, selecione o portfólio empresarial e a conta do Instagram que será compartilhada.',
  perfil: 'Não foi possível ler os dados da conta do Instagram agora. Tente de novo.',
  expirado: 'O acesso ao Instagram deixou de valer. Conecte de novo.',
  salvar: 'Não foi possível salvar a conexão. Tente de novo.',
};
export function instagramErrorMessage(code: string | null | undefined) {
  return (code && code in MESSAGES ? MESSAGES[code as InstagramErrorCode] : null) ?? 'Não foi possível conectar o Instagram agora. Tente de novo.';
}

export const maskId = (value: string) => (value.length <= 5 ? '•'.repeat(value.length) : `${value.slice(0, 3)}${'•'.repeat(value.length - 5)}${value.slice(-2)}`);