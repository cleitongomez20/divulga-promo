import { z } from 'zod';

// Only what the connection needs now. Comments and messages (step "EU QUERO") need more permissions and will ask the user to connect again.
export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'] as const;
export const CALLBACK_PATH = '/api/public/instagram-callback';

export const instagramAppSchema = z.object({
  appId: z.string().trim().regex(/^\d{8,20}$/, 'O ID do app deve conter apenas números.'),
  appSecret: z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, 'O segredo do app deve ter apenas letras e números (de 16 a 64 caracteres).'),
});

export type InstagramErrorCode = 'negado' | 'estado' | 'app' | 'troca' | 'conta_pessoal' | 'permissao' | 'perfil' | 'renovacao' | 'expirado' | 'salvar';
const MESSAGES: Record<InstagramErrorCode, string> = {
  negado: 'Você cancelou a autorização no Instagram. Se quiser, tente de novo.',
  estado: 'O pedido de conexão expirou ou não é válido. Clique em Conectar Instagram de novo.',
  app: 'Salve primeiro o ID e o segredo do app da Meta.',
  troca: 'Não foi possível concluir a conexão com o Instagram. Confira o ID e o segredo do app e o endereço de retorno, e tente de novo.',
  conta_pessoal: 'Essa conta do Instagram é pessoal. Mude para conta profissional (Comercial ou Criador de conteúdo) e conecte de novo.',
  permissao: 'A permissão de publicar não foi concedida. Conecte de novo e aceite todas as permissões.',
  perfil: 'A conexão foi feita, mas não foi possível ler os dados da conta. Tente de novo.',
  renovacao: 'Não foi possível renovar o acesso agora. Se o problema continuar, desconecte e conecte de novo.',
  expirado: 'O acesso ao Instagram expirou. Conecte de novo.',
  salvar: 'Não foi possível salvar a conexão. Tente de novo.',
};
export function instagramErrorMessage(code: string | null | undefined) {
  return (code && code in MESSAGES ? MESSAGES[code as InstagramErrorCode] : null) ?? 'Não foi possível conectar o Instagram agora. Tente de novo.';
}

export const daysLeft = (expiresAtMs: number, nowMs: number) => Math.max(0, Math.floor((expiresAtMs - nowMs) / 86_400_000));
export const maskId = (value: string) => (value.length <= 5 ? '•'.repeat(value.length) : `${value.slice(0, 3)}${'•'.repeat(value.length - 5)}${value.slice(-2)}`);