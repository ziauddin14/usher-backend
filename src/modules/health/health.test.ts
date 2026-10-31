import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { seedDemo } from '../../seed/seed.js';

describe('health & meta', () => {
  const app = createApp();

  beforeAll(async () => {
    await seedDemo({ reset: true });
  });

  it('GET /health → ok with db up', async () => {
    const res = await request(app).get('/api/v1/health').expect(200);
    expect(res.body).toEqual({ ok: true, db: 'up', time: expect.any(String) });
  });

  it('GET /meta needs a session', async () => {
    await request(app).get('/api/v1/meta').expect(401);
  });

  it('GET /meta returns the seeded rules and today in Karachi', async () => {
    const cookie = await loginCookie(app, '9090412');
    const res = await request(app).get('/api/v1/meta').set('Cookie', cookie).expect(200);
    expect(res.body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.backdateDays).toBe(3);
    expect(res.body.atiyatCategories).toHaveLength(12);
    const excluded = (res.body.atiyatCategories as { id: string; rewardIncluded: boolean }[])
      .filter((c) => !c.rewardIncluded)
      .map((c) => c.id);
    expect(excluded).toEqual(['tameer', 'fgrf', 'deg']);
    expect(res.body.reward).toMatchObject({
      divisor: 6,
      tiers: [
        { minAvg: 300000, amount: 10000 },
        { minAvg: 200000, amount: 5000 },
      ],
    });
  });

  it('unknown routes return the error envelope', async () => {
    const res = await request(app).get('/api/v1/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
