/**
 * Workers 运行时没有 node:crypto 的 scrypt，这里用 WebCrypto 的 PBKDF2-SHA256。
 * 哈希格式：pbkdf2$<iterations>$<saltB64>$<hashB64>
 */

const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;
export const COOKIE_NAME = 'fn_session';
export const SESSION_TTL = 30 * 24 * 3600 * 1000;

function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function toB64Url(bytes) {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pbkdf2(password, salt, iterations, bits = 256) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const buf = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    bits
  );
  return new Uint8Array(buf);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts[0] !== 'pbkdf2' || parts.length !== 4) return false;
  const iterations = Number(parts[1]) || PBKDF2_ITERATIONS;
  const salt = fromB64(parts[2]);
  const expected = fromB64(parts[3]);
  const actual = await pbkdf2(password, salt, iterations, expected.length * 8);
  return timingSafeEqual(actual, expected);
}

export async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(str)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newToken() {
  return toB64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function newId() {
  return crypto.randomUUID();
}

export function parseCookies(request) {
  const out = {};
  const header = request.headers.get('cookie');
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function isHttps(request) {
  const url = new URL(request.url);
  return url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
}

export function sessionCookie(request, token) {
  const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_TTL / 1000}`];
  if (isHttps(request)) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(request) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(request)) parts.push('Secure');
  return parts.join('; ');
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    disabled: !!row.disabled,
    isDefaultPassword: !!row.is_default_password,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export async function createSession(db, userId, request) {
  const token = newToken();
  const id = await sha256Hex(token);
  const now = Date.now();
  await db.insertSession({
    id,
    user_id: userId,
    created_at: now,
    expires_at: now + SESSION_TTL,
    user_agent: (request.headers.get('user-agent') || '').slice(0, 200),
    ip: (request.headers.get('cf-connecting-ip') || '').slice(0, 60),
  });
  return token;
}

export async function currentUser(db, request) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return null;
  const id = await sha256Hex(token);
  const row = await db.sessionUser(id);
  if (!row) return null;
  if (row.disabled) {
    await db.deleteSession(id);
    return null;
  }
  return row;
}

export async function destroySession(db, request) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return;
  await db.deleteSession(await sha256Hex(token));
}
