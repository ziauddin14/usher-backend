import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { Village } from '../../models/village.js';
import { seedDemo } from '../../seed/seed.js';

interface Row {
  id: string;
  name: string;
  district: { code: string } | null;
  division: { code: string } | null;
  zimmedar: { ajeerCode: string } | null;
  issues: { kind: string }[];
}

// CTO 17 Nov 2026: the Gaon list opens on every Gaon, with Suba / Division / District and status
// filters.
describe('GET /dash/villages (all Gaon, filtered)', () => {
  const app = createApp();
  let admin = '';
  let division = '';
  let district = '';
  let live = 0;

  beforeAll(async () => {
    await seedDemo({ reset: true });
    // One pool Gaon with a problem, so every filter has something to find.
    await Village.updateOne(
      { districtCode: 'GHOTKI', status: 'approved' },
      { $unset: { assignedTo: 1 }, $set: { issues: [{ kind: 'ZIMMEDAR_NOT_FOUND' }] } },
    );
    live = await Village.countDocuments({ status: { $in: ['approved', 'pending'] } });
    admin = await loginCookie(app, '9100001');
    division = await loginCookie(app, '9030001');
    district = await loginCookie(app, '9040001');
  });

  const get = (cookie: string, qs = '') =>
    request(app).get(`/api/v1/dash/villages${qs}`).set('Cookie', cookie);

  it('the Admin sees every Gaon, 50 per page, with counts', async () => {
    const res = await get(admin).expect(200);
    expect(res.body.total).toBe(live);
    expect(res.body.counts.all).toBe(live);
    expect(res.body.villages.length).toBe(Math.min(50, live));
    expect(res.body.counts.pool).toBeGreaterThanOrEqual(1);
    expect(res.body.counts.issues).toBeGreaterThanOrEqual(1);
    expect(res.body.counts.assigned + res.body.counts.pool + res.body.counts.orphaned).toBe(live);
  });

  it('filters by District, Division, zimmedar and problem', async () => {
    const ghotki = await get(admin, '?district=GHOTKI').expect(200);
    const rows = ghotki.body.villages as Row[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.district?.code === 'GHOTKI' && r.division?.code === 'SUKKUR')).toBe(
      true,
    );

    const pool = (await get(admin, '?assigned=no').expect(200)).body.villages as Row[];
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((r) => r.zimmedar === null)).toBe(true);

    const assigned = (await get(admin, '?district=GHOTKI&assigned=yes').expect(200)).body
      .villages as Row[];
    expect(assigned.every((r) => r.zimmedar !== null)).toBe(true);

    const issues = (await get(admin, '?issue=ZIMMEDAR_NOT_FOUND').expect(200)).body
      .villages as Row[];
    expect(issues.length).toBe(1);
    expect((await get(admin, '?issue=no').expect(200)).body.total).toBe(live - 1);

    const none = await get(admin, '?division=HYDERABAD&district=GHOTKI').expect(200);
    // The narrowest unit wins.
    expect(none.body.total).toBe(ghotki.body.total);
  });

  it('finds by name', async () => {
    const one = (await get(admin, '?district=GHOTKI').expect(200)).body.villages[0] as Row;
    const res = await get(admin, `?q=${encodeURIComponent(one.name)}`).expect(200);
    expect((res.body.villages as Row[]).some((r) => r.id === one.id)).toBe(true);
  });

  it('a Division sees only its own Gaon; another unit is 404', async () => {
    const res = await get(division).expect(200);
    expect((res.body.villages as Row[]).every((r) => r.division?.code === 'SUKKUR')).toBe(true);
    await get(division, '?division=LARKANA').expect(404);
    await get(district, '?district=SUKKUR_DIST').expect(404);
  });

  it('units for the filters stay in scope', async () => {
    const res = await request(app)
      .get('/api/v1/dash/units-tree')
      .set('Cookie', division)
      .expect(200);
    const codes = (res.body.units as { code: string }[]).map((u) => u.code);
    expect(codes).toContain('SUKKUR');
    expect(codes).toContain('GHOTKI');
    expect(codes).not.toContain('LARKANA');
    expect(codes).not.toContain('INT_SINDH');
  });

  it('rejects a bad filter', async () => {
    const res = await get(admin, '?issue=MAYBE').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});
