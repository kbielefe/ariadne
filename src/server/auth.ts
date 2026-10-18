// Shared secret for remote access (Cursor MCP, UI, steward). Localhost-only installs leave it unset.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const TOKEN_COOKIE = 'ariadne_token';

/** Constant-time compare of two UTF-8 strings (false if lengths differ). */
export function secretEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Bearer token from Authorization, or the session cookie set by POST /api/auth. */
export function presentedToken(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  const m = typeof auth === 'string' ? /^Bearer\s+(\S+)$/i.exec(auth) : null;
  if (m) return m[1];
  return cookieValue(req.headers.cookie, TOKEN_COOKIE);
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return part.slice(i + 1).trim();
    }
  }
  return undefined;
}

export function setTokenCookie(reply: FastifyReply, token: string, secure: boolean) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${60 * 60 * 24 * 365}`];
  if (secure) flags.push('Secure');
  reply.header('set-cookie', `${TOKEN_COOKIE}=${encodeURIComponent(token)}; ${flags.join('; ')}`);
}

export function clearTokenCookie(reply: FastifyReply, secure: boolean) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) flags.push('Secure');
  reply.header('set-cookie', `${TOKEN_COOKIE}=; ${flags.join('; ')}`);
}

/** Origin may be http or https against an allowed Host (with or without an explicit port). */
export function originAllowed(origin: string, allowedHosts: string[]): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return allowedHosts.some((h) => h === u.host || h === u.hostname);
}
