import { createServerFn } from '@tanstack/react-start';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { instanceNameFor, maskPhone, stateToStatus, whatsappErrorMessage, type WhatsAppStatus } from './whatsapp';

export type WhatsAppSnapshot = {
  configured: boolean; connection: WhatsAppStatus; qr: string | null;
  phoneMasked: string | null; profileName: string | null; connectedAt: string | null;
};
export type WhatsAppResult = { ok: true; snapshot: WhatsAppSnapshot } | { ok: false; message: string };

// Os tipos gerados do banco ainda não conhecem a tabela nova, então este arquivo fala com o banco sem eles.
async function admin() { return (await import('@/integrations/supabase/client.server')).supabaseAdmin as unknown as SupabaseClient; }

/** Espaço mínimo entre ações do mesmo usuário, para os botões não serem martelados. */
async function tooSoon(db: SupabaseClient, scope: string, ms: number) {
  const { data, error } = await db.rpc('reserve_connector_slot', { p_scope: scope, p_interval_ms: ms });
  if (error) return false;
  return typeof data === 'number' && data > 0;
}
const log = (db: SupabaseClient, userId: string, action: string, result: string) => db.from('activity_log').insert({ user_id: userId, action, result, details: {} });

type Row = { status: WhatsAppStatus; phone: string | null; profile_name: string | null; connected_at: string | null } | null;
async function readRow(db: SupabaseClient, userId: string): Promise<Row> {
  const { data } = await db.from('whatsapp_connections').select('status,phone,profile_name,connected_at').eq('user_id', userId).maybeSingle();
  return (data as Row) ?? null;
}
const snapshotOf = async (row: Row, qr: string | null): Promise<WhatsAppSnapshot> => {
  const { isWhatsAppConfigured } = await import('./whatsapp.server');
  return { configured: isWhatsAppConfigured(), connection: row?.status ?? 'disconnected', qr, phoneMasked: maskPhone(row?.phone), profileName: row?.profile_name ?? null, connectedAt: row?.connected_at ?? null };
};
const failure = async (error: unknown): Promise<WhatsAppResult> => {
  const { WhatsAppError } = await import('./whatsapp.server');
  return { ok: false, message: whatsappErrorMessage(error instanceof WhatsAppError ? error.kind : 'server') };
};

/** Marca o estado no banco e registra no histórico quando o WhatsApp acabou de conectar. */
async function save(db: SupabaseClient, userId: string, name: string, status: WhatsAppStatus, before: Row): Promise<Row> {
  const { fetchOwner } = await import('./whatsapp.server');
  const owner = status === 'connected' ? await fetchOwner(name) : { phone: null, profileName: null };
  const justConnected = status === 'connected' && before?.status !== 'connected';
  const next = {
    user_id: userId, instance_name: name, status, last_error: null,
    phone: status === 'connected' ? owner.phone ?? before?.phone ?? null : null,
    profile_name: status === 'connected' ? owner.profileName ?? before?.profile_name ?? null : null,
    connected_at: status === 'connected' ? (justConnected ? new Date().toISOString() : before?.connected_at ?? null) : null,
  };
  const { error } = await db.from('whatsapp_connections').upsert(next, { onConflict: 'user_id' });
  if (error) throw new Error('db');
  if (justConnected) await log(db, userId, 'WhatsApp conectado', maskPhone(next.phone) ?? 'Número não informado');
  return { status: next.status, phone: next.phone, profile_name: next.profile_name, connected_at: next.connected_at };
}

/** Lê só o que está salvo no app (não fala com o servidor do WhatsApp). */
export const getWhatsAppStatus = createServerFn({ method: 'GET' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<WhatsAppSnapshot> => {
  const db = await admin();
  return snapshotOf(await readRow(db, context.userId), null);
});

/** Cria a conexão (se não existir) e devolve o QR code para escanear. */
export const startWhatsAppConnection = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<WhatsAppResult> => {
  try {
    const db = await admin();
    if (await tooSoon(db, `whatsapp-edit:${context.userId}`, 3000)) return { ok: false, message: 'Aguarde alguns segundos e tente de novo.' };
    const { getInstanceState, createInstance, fetchQr, WhatsAppError } = await import('./whatsapp.server');
    const name = instanceNameFor(context.userId);
    const before = await readRow(db, context.userId);
    const found = await getInstanceState(name);
    if (found.exists && stateToStatus(found.state) === 'connected') return { ok: true, snapshot: await snapshotOf(await save(db, context.userId, name, 'connected', before), null) };
    let qr = found.exists ? await fetchQr(name) : await createInstance(name);
    if (!qr) qr = await fetchQr(name);
    if (!qr) throw new WhatsAppError('no_qr');
    return { ok: true, snapshot: await snapshotOf(await save(db, context.userId, name, 'waiting_qr', before), qr) };
  } catch (error) { return failure(error); }
});

/** Pergunta ao servidor se o WhatsApp já foi conectado; com wantQr, também traz um QR novo. */
export const refreshWhatsAppStatus = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
  .inputValidator(input => z.object({ wantQr: z.boolean() }).strict().parse(input)).handler(async ({ context, data }): Promise<WhatsAppResult> => {
    try {
      const db = await admin();
      if (await tooSoon(db, `whatsapp-poll:${context.userId}`, 1500)) return { ok: true, snapshot: await snapshotOf(await readRow(db, context.userId), null) };
      const { getInstanceState, fetchQr } = await import('./whatsapp.server');
      const name = instanceNameFor(context.userId);
      const before = await readRow(db, context.userId);
      const found = await getInstanceState(name);
      const status: WhatsAppStatus = found.exists ? stateToStatus(found.state) : 'disconnected';
      const row = await save(db, context.userId, name, status, before);
      const qr = data.wantQr && status !== 'connected' && found.exists ? await fetchQr(name) : null;
      return { ok: true, snapshot: await snapshotOf(row, qr) };
    } catch (error) { return failure(error); }
  });

/** Desconecta o aparelho, apaga a conexão no servidor e remove o registro. */
export const disconnectWhatsApp = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth]).handler(async ({ context }): Promise<WhatsAppResult> => {
  try {
    const db = await admin();
    const { removeInstance } = await import('./whatsapp.server');
    await removeInstance(instanceNameFor(context.userId));
    const { error } = await db.from('whatsapp_connections').delete().eq('user_id', context.userId);
    if (error) return { ok: false, message: 'Desconectei no servidor, mas não consegui limpar o registro. Tente de novo.' };
    await log(db, context.userId, 'WhatsApp desconectado', 'Aparelho desconectado');
    return { ok: true, snapshot: await snapshotOf(null, null) };
  } catch (error) { return failure(error); }
});
