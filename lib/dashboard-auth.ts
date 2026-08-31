// OzarEye
// Copyright (C) 2026 H. Soualmi
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import crypto from 'node:crypto';

// Single shared password, HMAC-signed session cookie. No accounts, no DB
// table — the password itself (from .env.local, read server-side only) is
// the signing key, so a valid cookie can only have been minted by this server.
export const SESSION_COOKIE_NAME = 'algerie_feux_session';
const SESSION_TTL_MS = 30 * 24 * 3_600_000; // 30 days

function secret(): string {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) throw new Error('DASHBOARD_PASSWORD non configuré');
  return password;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a), bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export function verifyPassword(candidate: string): boolean {
  return safeEqual(candidate, secret());
}

export function createSessionCookieValue(): string {
  const payload = `ok.${Date.now() + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionCookieValue(value: string | undefined | null): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [tag, expiresStr, signature] = parts;
  const payload = `${tag}.${expiresStr}`;
  if (!safeEqual(signature, sign(payload))) return false;
  const expires = Number(expiresStr);
  return tag === 'ok' && Number.isFinite(expires) && Date.now() <= expires;
}

function parseCookieHeader(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === SESSION_COOKIE_NAME) return rest.join('=');
  }
  return undefined;
}

// Every /api/dashboard/* route calls this first. Reads the raw Cookie header
// directly rather than a framework cookie API — simpler, and matches how
// /api/monitor already checks its own header-based secret in this codebase.
export function isAuthenticated(request: Request): boolean {
  return verifySessionCookieValue(parseCookieHeader(request.headers.get('cookie')));
}

export function sessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=${createSessionCookieValue()}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}
