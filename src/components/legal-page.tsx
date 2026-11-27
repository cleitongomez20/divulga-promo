import type { ReactNode } from 'react';
import { Brand } from '@/components/brand';
import { SITE_NAME } from '@/lib/legal';

/** Shared layout of the public legal pages: reachable without login, readable on a phone, same look as the app. */
export function LegalPage({ title, updated, intro, children }: { title: string; updated: string; intro?: ReactNode; children: ReactNode }) {
  return <div className="min-h-screen bg-background">
    <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-7">
      <a href="/" aria-label="Voltar ao início"><Brand /></a>
      <a href="/" className="text-sm font-medium text-primary hover:underline">Voltar ao início</a>
    </header>
    <main className="mx-auto max-w-3xl px-6 pb-16">
      <h1 className="text-3xl font-bold leading-tight sm:text-4xl">{title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">Atualizada em {updated}</p>
      {intro && <p className="mt-6 max-w-[68ch] text-base leading-relaxed">{intro}</p>}
      <div className="mt-10 space-y-10">{children}</div>
    </main>
    <footer className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-5 gap-y-2 border-t px-6 py-8 text-xs text-muted-foreground">
      <span>© {new Date().getFullYear()} {SITE_NAME}</span>
      <a href="/privacidade" className="underline">Política de privacidade</a>
      <a href="/exclusao-de-dados" className="underline">Exclusão de dados</a>
    </footer>
  </div>;
}

export function Section({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return <section id={id} className="scroll-mt-8">
    <h2 className="border-t pt-6 text-xl font-semibold">{title}</h2>
    <div className="mt-3 max-w-[68ch] space-y-3 text-[15px] leading-relaxed">{children}</div>
  </section>;
}

export function Bullets({ items }: { items: ReactNode[] }) {
  return <ul className="list-disc space-y-2 pl-5">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
}

