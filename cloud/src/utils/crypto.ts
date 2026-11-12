const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomBase62(length: number): string {
  // 拒绝采样，避免取模偏差
  const out: string[] = [];
  while (out.length < length) {
    const batch = randomBytes(length * 2);
    for (const byte of batch) {
      if (byte < 248 && out.length < length) out.push(BASE62[byte % 62]!);
    }
  }
  return out.join('');
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new Error('invalid hex');
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('invalid hex');
    bytes[i] = byte;
  }
  return bytes;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return toHex(new Uint8Array(signature));
}

/** 生成 API token：srk_ + 32 字节 base64url */
export function generateToken(): string {
  return `srk_${base64UrlEncode(randomBytes(32))}`;
}

export function tokenPrefix(token: string): string {
  return token.slice(0, 12);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBase62(24)}`;
}

// ---------------- AES-GCM 加密（用于推送凭据） ----------------

async function deriveAesKey(rawKeyBase64: string): Promise<CryptoKey> {
  const raw = base64Decode(rawKeyBase64);
  if (raw.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes (base64)');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext: string, keyBase64: string, aad: string): Promise<string> {
  const key = await deriveAesKey(keyBase64);
  const iv = randomBytes(12);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return base64Encode(combined);
}

export async function decryptSecret(payload: string, keyBase64: string, aad: string): Promise<string> {
  if (!payload) return '';
  const combined = base64Decode(payload);
  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const key = await deriveAesKey(keyBase64);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    key,
    cipher,
  );
  return new TextDecoder().decode(plain);
}
