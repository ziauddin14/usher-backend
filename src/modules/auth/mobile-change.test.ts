// A later change of a registered mobile (CTO 7 Nov 2026): the user asks, the old number keeps
// working, and only the user's verifier (the first-login hierarchy) confirms or rejects. Audited,
// numbers masked. Invented seed data only.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { AuditLog } from '../../models/audit-log.js';
import { User } from '../../models/user.js';
import { seedDemo } from '../../seed/seed.js';

const app = createApp();
const OLD = '03001230001';
const NEW = '03451230002';
let zimmedarId: string;

describe('mobile change after the first login', () => {
  beforeAll(async () => {
    await seedDemo({ reset: true });
    await User.updateOne(
      { ajeerCode: '9090412' },
      { $set: { mobile: OLD, mobileVerified: true }, $unset: { mobileChange: 1 } },
    );
    zimmedarId = String((await User.findOne({ ajeerCode: '9090412' }).lean())!._id);
  });

  it('needs a session with the password already changed', async () => {
    await request(app).post('/api/v1/auth/mobile-change').send({ mobile: NEW }).expect(401);
  });

  it('refuses an invalid or the same number', async () => {
    const cookie = await loginCookie(app, '9090412');
    const bad = await request(app)
      .post('/api/v1/auth/mobile-change')
      .set('Cookie', cookie)
      .send({ mobile: '12345' })
      .expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    const same = await request(app)
      .post('/api/v1/auth/mobile-change')
      .set('Cookie', cookie)
      .send({ mobile: '0300-1230001' })
      .expect(400);
    expect(same.body.error.details.reason).toBe('SAME_MOBILE');
  });

  it('a request keeps the old number registered until the verifier confirms', async () => {
    const cookie = await loginCookie(app, '9090412');
    await request(app)
      .post('/api/v1/auth/mobile-change')
      .set('Cookie', cookie)
      .send({ mobile: NEW })
      .expect(200);
    const own = await request(app).get('/api/v1/auth/mobile').set('Cookie', cookie).expect(200);
    expect(own.body).toMatchObject({
      mobile: '0300•••0001',
      mobileChange: { mobile: '0345•••0002' },
    });
    expect((await User.findById(zimmedarId).lean())?.mobile).toBe(OLD);
    // The user keeps working normally meanwhile.
    await request(app).get('/api/v1/me/summary').set('Cookie', cookie).expect(200);
    const log = await AuditLog.findOne({ action: 'MOBILE_CHANGE_REQUEST', targetId: zimmedarId });
    expect(JSON.stringify(log?.details)).not.toContain(NEW);
  });

  it('only the level directly above verifies (District for a zimmedar)', async () => {
    for (const code of ['9030001', '9020001', '9010001']) {
      const cookie = await loginCookie(app, code);
      await request(app)
        .post(`/api/v1/users/${zimmedarId}/confirm-mobile-change`)
        .set('Cookie', cookie)
        .expect(403);
    }
    const zimmedar = await loginCookie(app, '9090412');
    await request(app)
      .post(`/api/v1/users/${zimmedarId}/confirm-mobile-change`)
      .set('Cookie', zimmedar)
      .expect(403);
    expect((await User.findById(zimmedarId).lean())?.mobile).toBe(OLD);
  });

  it('a District of another district cannot see it (404)', async () => {
    const other = await User.findOne({ role: 'zimmedar', unitCode: { $ne: 'GHOTKI' } }).lean();
    await User.updateOne(
      { _id: other!._id },
      {
        $set: {
          mobile: OLD,
          mobileVerified: true,
          mobileChange: { mobile: NEW, requestedAt: new Date() },
        },
      },
    );
    const district = await loginCookie(app, '9040001');
    await request(app)
      .post(`/api/v1/users/${String(other!._id)}/confirm-mobile-change`)
      .set('Cookie', district)
      .expect(404);
    await User.updateOne({ _id: other!._id }, { $unset: { mobileChange: 1 } });
  });

  it('the District lists it, sees the full number (audited) and confirms', async () => {
    const district = await loginCookie(app, '9040001');
    const list = await request(app)
      .get('/api/v1/users?mobileStatus=change')
      .set('Cookie', district)
      .expect(200);
    expect(list.body.users).toHaveLength(1);
    expect(list.body.users[0]).toMatchObject({
      id: zimmedarId,
      mobile: '0300•••0001',
      mobileChange: { mobile: '0345•••0002' },
    });
    const full = await request(app)
      .get(`/api/v1/users/${zimmedarId}/pending-mobile-change`)
      .set('Cookie', district)
      .expect(200);
    expect(full.body.mobile).toBe(NEW);
    expect(await AuditLog.countDocuments({ action: 'MOBILE_CHANGE_VIEW' })).toBe(1);

    await request(app)
      .post(`/api/v1/users/${zimmedarId}/confirm-mobile-change`)
      .set('Cookie', district)
      .expect(200);
    const saved = await User.findById(zimmedarId).lean();
    expect(saved).toMatchObject({ mobile: NEW, mobileVerified: true });
    expect(saved?.mobileChange).toBeUndefined();
    const log = await AuditLog.findOne({ action: 'MOBILE_CHANGE_CONFIRM' }).lean();
    expect(log?.details).toMatchObject({ from: '0300•••0001', to: '0345•••0002' });

    // Forgot password now uses the new number.
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ ajeerCode: '9090412', mobile: NEW })
      .expect(200);
    expect(
      await AuditLog.countDocuments({ action: 'PASSWORD_RESET_REQUEST', targetId: zimmedarId }),
    ).toBe(1);
  });

  it('reject removes the request and keeps the registered number; cancel works too', async () => {
    const cookie = await loginCookie(app, '9090412');
    const district = await loginCookie(app, '9040001');
    await request(app)
      .post('/api/v1/auth/mobile-change')
      .set('Cookie', cookie)
      .send({ mobile: '03111230003' })
      .expect(200);
    await request(app)
      .post(`/api/v1/users/${zimmedarId}/reject-mobile-change`)
      .set('Cookie', district)
      .expect(200);
    let saved = await User.findById(zimmedarId).lean();
    expect(saved).toMatchObject({ mobile: NEW });
    expect(saved?.mobileChange).toBeUndefined();
    await request(app)
      .post(`/api/v1/users/${zimmedarId}/reject-mobile-change`)
      .set('Cookie', district)
      .expect(409);

    await request(app)
      .post('/api/v1/auth/mobile-change')
      .set('Cookie', cookie)
      .send({ mobile: '03111230004' })
      .expect(200);
    await request(app).delete('/api/v1/auth/mobile-change').set('Cookie', cookie).expect(200);
    saved = await User.findById(zimmedarId).lean();
    expect(saved?.mobileChange).toBeUndefined();
    for (const action of ['MOBILE_CHANGE_REJECT', 'MOBILE_CHANGE_CANCEL'] as const) {
      expect(await AuditLog.countDocuments({ action })).toBe(1);
    }
  });
});
