import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { seedDemo } from '../../seed/seed.js';

interface ListedUser {
  ajeerCode: string;
  role: string;
  unitCode: string;
}

describe('GET /users (supervisor-only, scoped)', () => {
  const app = createApp();

  beforeAll(async () => {
    await seedDemo({ reset: true });
  });

  it('a zimmedar token cannot call a supervisor-only endpoint (403)', async () => {
    const cookie = await loginCookie(app, '9090412');
    const res = await request(app).get('/api/v1/users').set('Cookie', cookie).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('requires a session (401)', async () => {
    await request(app).get('/api/v1/users').expect(401);
  });

  it('district sees only the zimmedaran of its own district', async () => {
    const cookie = await loginCookie(app, '9040001');
    const res = await request(app).get('/api/v1/users').set('Cookie', cookie).expect(200);
    const users = res.body.users as ListedUser[];
    expect(users).toHaveLength(10);
    expect(users.every((u) => u.unitCode === 'GHOTKI' && u.role === 'zimmedar')).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('district cannot list another district (404)', async () => {
    const cookie = await loginCookie(app, '9040001');
    const res = await request(app)
      .get('/api/v1/users?unit=LARKANA_DIST')
      .set('Cookie', cookie)
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('division sees its districts and their zimmedaran, not other divisions', async () => {
    const cookie = await loginCookie(app, '9030001');
    const res = await request(app).get('/api/v1/users').set('Cookie', cookie).expect(200);
    const users = res.body.users as ListedUser[];
    expect(new Set(users.map((u) => u.unitCode))).toEqual(
      // Khairpur's Ushar and its Tehsil login sit under the demo Tehsil KHAIRPUR_TOWN.
      new Set(['GHOTKI', 'SUKKUR_DIST', 'KHAIRPUR_TOWN']),
    );
    expect(users.some((u) => u.role === 'tehsil' && u.ajeerCode === '9050001')).toBe(true);
    expect(users.some((u) => u.role === 'district')).toBe(true);
    expect(users.some((u) => u.role === 'division')).toBe(false);
  });

  it('searches by name or ajeer code', async () => {
    const cookie = await loginCookie(app, '9010001');
    const res = await request(app).get('/api/v1/users?q=9090412').set('Cookie', cookie).expect(200);
    expect((res.body.users as ListedUser[]).map((u) => u.ajeerCode)).toEqual(['9090412']);
  });
});
