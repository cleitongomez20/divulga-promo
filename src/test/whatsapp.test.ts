import { describe, expect, it } from 'vitest';
import { instanceNameFor, maskPhone, normalizeQr, phoneFromJid, stateToStatus } from '@/lib/whatsapp';

describe('conexão do WhatsApp', () => {
  it('cria um nome de instância só com letras e números', () => {
    expect(instanceNameFor('0f8c-12ab-34cd')).toBe('dp_0f8c12ab34cd');
  });
  it('traduz o estado do servidor', () => {
    expect(stateToStatus('open')).toBe('connected');
    expect(stateToStatus('connecting')).toBe('waiting_qr');
    expect(stateToStatus('close')).toBe('disconnected');
    expect(stateToStatus(null)).toBe('disconnected');
  });
  it('aceita o QR com ou sem prefixo e recusa lixo', () => {
    const body = 'A'.repeat(120);
    expect(normalizeQr(`data:image/png;base64,${body}`)).toBe(`data:image/png;base64,${body}`);
    expect(normalizeQr(body)).toBe(`data:image/png;base64,${body}`);
    expect(normalizeQr('')).toBeNull();
    expect(normalizeQr('data:text/html;base64,AAAA')).toBeNull();
    expect(normalizeQr(42)).toBeNull();
  });
  it('tira o número do identificador e mostra só o final', () => {
    expect(phoneFromJid('5581999991234@s.whatsapp.net')).toBe('5581999991234');
    expect(phoneFromJid('5581999991234:12@s.whatsapp.net')).toBe('5581999991234');
    expect(phoneFromJid('grupo@g.us')).toBeNull();
    expect(maskPhone('5581999991234')).toBe('•••• 1234');
    expect(maskPhone(null)).toBeNull();
  });
});
