import { randomBytes, timingSafeEqual } from 'node:crypto';

/** A fresh 256-bit bearer token, generated once per activation. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** True when the Authorization header carries exactly `Bearer <token>`. Constant-time. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (match === null || match[1] === undefined) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
