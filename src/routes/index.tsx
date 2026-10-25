import { createFileRoute } from '@tanstack/react-router';
import { LoginPage } from '@/components/login-page';
import { pageHead } from '@/lib/metadata';
export const Route = createFileRoute('/')({ head: () => pageHead('Bem-vindo', 'Acesse seu espaço privado de divulgação de produtos e acompanhe sua conta.'), component: LoginPage });
