// Seals small JSON values (tokens, app credentials) with AES-GCM. Each value is tied to one user and one purpose,
// so a sealed value cannot be moved to another user or used for another purpose.
const encoder = new TextEncoder();

async function aesKey(masterKey: string) {
  if (!masterKey) throw new Error('O armazenamento seguro ainda não está disponível.');
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(masterKey));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealJson(value: unknown, masterKey: string, userId: string, purpose: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${purpose}:${userId}:v1`) }, await aesKey(masterKey), encoder.encode(JSON.stringify(value)));
  const bytes = new Uint8Array(iv.length + ciphertext.byteLength);
  bytes.set(iv); bytes.set(new Uint8Array(ciphertext), iv.length);
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
}

export async function openJson<T>(ciphertext: string, masterKey: string, userId: string, purpose: string): Promise<T> {
  const bytes = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
  if (bytes.length < 29) throw new Error('Dados protegidos inválidos.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(`${purpose}:${userId}:v1`) }, await aesKey(masterKey), bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}