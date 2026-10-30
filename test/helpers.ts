import request from 'supertest';
import type { createApp } from '../src/index.js';
import { DEMO_PASSWORD } from '../src/seed/data.js';

/** Log in through the API and return the session cookie header. */
export async function loginCookie(
  app: ReturnType<typeof createApp>,
  ajeerCode: string,
  password = DEMO_PASSWORD,
): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ ajeerCode, password });
  if (res.status !== 200) throw new Error(`login ${ajeerCode} failed: ${res.status}`);
  const cookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  return cookie?.[0]?.split(';')[0] ?? '';
}
