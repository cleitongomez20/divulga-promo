import { createFileRoute } from '@tanstack/react-router';
import { LoginPage } from '@/components/login-page';
import { pageHead } from '@/lib/metadata';
export const Route = createFileRoute('/')({ head: () => pageHead('Acesso com e-mail e senha', 'Acesse o Divulga Promo com seu e-mail e sua senha e acompanhe sua conta.'), component: LoginPage });
