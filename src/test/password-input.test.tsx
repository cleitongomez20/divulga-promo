import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PasswordInput } from '@/components/password-input';

describe('Password visibility', () => {
  it('starts hidden and can reveal and conceal without submitting', () => {
    let submissions = 0;
    render(<form onSubmit={event => { event.preventDefault(); submissions++; }}><PasswordInput id="password" aria-label="Senha" autoComplete="current-password" /></form>);
    const input = screen.getByLabelText('Senha');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar senha' }));
    expect(input).toHaveAttribute('type', 'text');
    expect(submissions).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Ocultar senha' }));
    expect(input).toHaveAttribute('type', 'password');
  });
  it('conceals again when submitting the form', () => {
    render(<form aria-label="Cadastro" onSubmit={event => event.preventDefault()}><PasswordInput aria-label="Senha" /></form>);
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar senha' }));
    fireEvent.submit(screen.getByRole('form', { name: 'Cadastro' }));
    expect(screen.getByLabelText('Senha')).toHaveAttribute('type', 'password');
  });
  it('conceals when switching between login and signup', () => {
    const { rerender } = render(<PasswordInput aria-label="Senha" resetKey="login" />);
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar senha' }));
    rerender(<PasswordInput aria-label="Senha" resetKey="signup" />);
    expect(screen.getByLabelText('Senha')).toHaveAttribute('type', 'password');
  });
});