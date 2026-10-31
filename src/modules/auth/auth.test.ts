import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { AuditLog } from '../../models/audit-log.js';
import { seedDemo } from '../../seed/seed.js';

describe('auth', () => {
  beforeAll(async () => {
    await seedDemo({ reset: true });
  });

  it('logs in with ajeer code + password, sets an httpOnly session cookie', async () => {
    const res = await request(createApp())
      .post('/api/v1/auth/login')
      .send({ ajeerCode: '9090412', password: 'demo1234' })
      .expect(200);

    expect(res.body.user).toMatchObject({
      ajeerCode: '9090412',
      name: 'Muhammad Arif',
      nameUr: 'محمد عارف',
      role: 'zimmedar',
      zimmedari: 'ushar',
      unit: {
        code: 'GHOTKI',
        path: 'PK/INT_SINDH/SUKKUR/GHOTKI',
        level: 'district',
        nameUr: 'گھوٹکی',
      },
      mustChangePassword: false,
    });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^ushr_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(await AuditLog.countDocuments({ action: 'LOGIN', actorAjeerCode: '9090412' })).toBe(1);
  });

  it('rejects a wrong password with INVALID_CREDENTIALS and audits it', async () => {
    const res = await request(createApp())
      .post('/api/v1/auth/login')
      .send({ ajeerCode: '9040001', password: 'wrong-password' })
      .expect(401);
    expect(res.body).toEqual({
      error: { code: 'INVALID_CREDENTIALS', message: expect.any(String) },
    });
    expect(
      await AuditLog.countDocuments({ action: 'LOGIN_FAILED', actorAjeerCode: '9040001' }),
    ).toBe(1);
  });

  it('rejects an unknown ajeer code the same way', async () => {
    const res = await request(createApp())
      .post('/api/v1/auth/login')
      .send({ ajeerCode: '55555', password: 'demo1234' })
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('validates the body', async () => {
    const res = await request(createApp())
      .post('/api/v1/auth/login')
      .send({ ajeerCode: 'abc' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rate-limits after 5 failed logins per ajeer code + IP (429)', async () => {
    const app = createApp();
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ ajeerCode: '9030001', password: 'nope' })
        .expect(401);
    }
    const blocked = await request(app)
      .post('/api/v1/auth/login')
      .send({ ajeerCode: '9030001', password: 'demo1234' })
      .expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');

    // Another ajeer code from the same IP is not blocked.
    await request(app)
      .post('/api/v1/auth/login')
      .send({ ajeerCode: '9020001', password: 'demo1234' })
      .expect(200);
  });

  it('GET /auth/me without a cookie → 401 UNAUTHENTICATED', async () => {
    const res = await request(createApp()).get('/api/v1/auth/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /auth/me with a tampered token → 401', async () => {
    await request(createApp())
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer not.a.token')
      .expect(401);
  });

  it('GET /auth/me returns the session user', async () => {
    const app = createApp();
    const cookie = await loginCookie(app, '9040001');
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
    expect(res.body.user).toMatchObject({
      ajeerCode: '9040001',
      role: 'district',
      unit: { code: 'GHOTKI' },
    });
  });

  it('logout clears the cookie', async () => {
    const res = await request(createApp()).post('/api/v1/auth/logout').expect(200);
    expect(String(res.headers['set-cookie'])).toMatch(/ushr_session=;/);
  });

  it('changes the password, then the new one works and the old one does not', async () => {
    const app = createApp();
    const cookie = await loginCookie(app, '9010001');

    const sameAsCode = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'demo1234', newPassword: '9010001' })
      .expect(400);
    expect(sameAsCode.body.error.code).toBe('VALIDATION_FAILED');

    const wrongCurrent = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'nope-nope', newPassword: 'new-pass-123' })
      .expect(400);
    expect(wrongCurrent.body.error.details.reason).toBe('WRONG_CURRENT_PASSWORD');

    await request(app)
      .post('/api/v1/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'demo1234', newPassword: 'new-pass-123' })
      .expect(200);
    expect(
      await AuditLog.countDocuments({ action: 'PASSWORD_CHANGE', actorAjeerCode: '9010001' }),
    ).toBe(1);

    await request(app)
      .post('/api/v1/auth/login')
      .send({ ajeerCode: '9010001', password: 'new-pass-123' })
      .expect(200);
    await request(app)
      .post('/api/v1/auth/login')
      .send({ ajeerCode: '9010001', password: 'demo1234' })
      .expect(401);
  });
});
