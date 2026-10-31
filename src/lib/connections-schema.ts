import { z } from 'zod';
export const credentialsSchema = z.object({
  appId: z.string().trim().regex(/^\d{1,64}$/, 'Confira seu AppId.'),
  secret: z.string().trim().min(1, 'Informe seu Secret.').max(2048, 'Confira seu Secret.'),
}).strict();