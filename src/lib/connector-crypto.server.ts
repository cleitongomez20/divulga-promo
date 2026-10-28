import type { Credentials } from './shopee.server';
const encoder = new TextEncoder();
async function encryptionKey(masterKey: string) {
  if (!masterKey) throw new Error('O armazenamento seguro ainda não está disponível.');
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(masterKey));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptCredentials(credentials: Credentials, masterKey: string, userId: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`shopee:${userId}:v1`) }, await encryptionKey(masterKey), encoder.encode(JSON.stringify(credentials)));
  const bytes = new Uint8Array(iv.length + ciphertext.byteLength);
  bytes.set(iv); bytes.set(new Uint8Array(ciphertext), iv.length);
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
}
export async function decryptCredentials(ciphertext: string, masterKey: string, userId: string): Promise<Credentials> {
  const bytes = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(`shopee:${userId}:v1`) }, await encryptionKey(masterKey), bytes.slice(12));
  const data = JSON.parse(new TextDecoder().decode(plain)) as Credentials;
  if (typeof data.appId !== 'string' || typeof data.secret !== 'string') throw new Error('Credenciais inválidas.');
  return data;
}