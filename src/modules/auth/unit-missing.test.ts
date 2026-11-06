import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { Unit } from '../../models/unit.js';
import { seedDemo } from '../../seed/seed.js';

const app = createApp();

// CTO, 6 Nov 2026: a missing unit is a data error. It must never make a Division or Suba user
// look like a District user; the API fails loudly and logs ids and codes only.
describe('user whose unit is missing', () => {
  beforeAll(async () => {
    await seedDemo({ reset: true });
  });

  afterAll(async () => {
    await seedDemo({ reset: true });
  });

  it('division and suba users keep their own level while the unit exists', async () => {
    for (const [code, level] of [
      ['9030001', 'division'],
      ['9020001', 'suba'],
      ['9040001', 'district'],
    ] as const) {
      const cookie = await loginCookie(app, code);
      const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);
      expect(me.body.user.unit.level).toBe(level);
    }
  });

  it('→ 500 INTERNAL (never a guessed "district"), logged without names or mobiles', async () => {
    const division = await loginCookie(app, '9030001');
    const suba = await loginCookie(app, '9020001');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await Unit.deleteMany({ code: { $in: ['SUKKUR', 'INT_SINDH'] } }); // test database only

    for (const cookie of [division, suba]) {
      const res = await request(app).get('/api/v1/auth/me').set('Cookie', cookie).expect(500);
      expect(res.body.error.code).toBe('INTERNAL');
      expect(JSON.stringify(res.body)).not.toContain('district');
    }
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ ajeerCode: '9030001', password: 'demo1234' })
      .expect(500);
    expect(login.body.error.code).toBe('INTERNAL');

    const logged = errors.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[auth]'));
    expect(logged.length).toBeGreaterThanOrEqual(3);
    expect(logged[0]).toMatch(/unitCode SUKKUR/);
    expect(logged.join(' ')).not.toMatch(/Ghulam|Mustafa|0300/);
    errors.mockRestore();
  });
});
