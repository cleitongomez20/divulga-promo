import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';

type PasswordInputProps = Omit<ComponentProps<'input'>, 'type'> & { resetKey?: unknown };

export function PasswordInput({ resetKey, className, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setVisible(false); }, [resetKey]);
  useEffect(() => {
    const form = input.current?.form;
    const hide = () => setVisible(false);
    form?.addEventListener('submit', hide, true);
    form?.addEventListener('reset', hide);
    return () => { form?.removeEventListener('submit', hide, true); form?.removeEventListener('reset', hide); };
  }, []);
  return <div className="relative">
    <input {...props} ref={input} type={visible ? 'text' : 'password'} className={cn('field pr-14', className)} />
    <Button type="button" variant="ghost" size="icon" disabled={props.disabled} aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={visible} aria-controls={props.id} className="absolute right-0 top-1/2 size-11 -translate-y-1/2 text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setVisible(value => !value)}>
      {visible ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
    </Button>
  </div>;
}