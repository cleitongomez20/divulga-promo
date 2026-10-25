import { createFileRoute } from '@tanstack/react-router';
import { LoginPage } from '@/components/login-page';
import { pageHead } from '@/lib/metadata';
export const Route = createFileRoute('/auth')({ head: () => pageHead('Entrar', 'Entre com e-mail ou senha no seu espaço protegido.'), component: LoginPage });