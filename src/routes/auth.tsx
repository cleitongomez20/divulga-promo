import { createFileRoute } from '@tanstack/react-router';
import { LoginPage } from '@/components/login-page';
import { pageHead } from '@/lib/metadata';
export const Route = createFileRoute('/auth')({ head: () => pageHead('Entrar com e-mail e senha', 'Entre com seu e-mail e sua senha no Divulga Promo.'), component: LoginPage });