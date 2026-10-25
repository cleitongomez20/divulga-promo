import { Megaphone } from 'lucide-react';
export function Brand() {
  return <span className="inline-flex items-center gap-2.5 font-bold text-xl text-foreground"><span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Megaphone className="size-5" /></span>Divulga <span className="text-primary">Promo</span></span>;
}