import bcrypt from 'bcryptjs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginCookie } from '../../../test/helpers.js';
import { createApp } from '../../index.js';
import { AuditLog } from '../../models/audit-log.js';
import { PasswordResetRequest } from '../../models/password-reset-request.js';
import { User } from '../../models/user.js';
import { seedDemo } from '../../seed/seed.js';

const app = createApp();

/** Put a seeded user into the "imported, never logged in" state: password 123 + mustChangePassword. */
async function makeNewUser(ajeerCode: string, mobile?: string): Promise<void> {
  const passwordHash = await bcrypt.hash('123', 4);
  await User.updateOne(
    { ajeerCode },
    mobile
      ? { $set: { passwordHash, mustChangePassword: true, mobile } }
      : { $set: { passwordHash, mustChangePassword: true }, $unset: { mobile: '' } },
  );
}

function login(body: Record<string, string>) {
  return request(app).post('/api/v1/auth/login').send(body);
}

describe('first login with the initial password 123', () => {
  let noMobile = ''; // a Ghotki zimmedar, so the demo district 9040001 can confirm the number
  beforeAll(async () => {
    await seedDemo({ reset: true });
    await makeNewUser('9000001', '03001112233');
    noMobile = (await User.findOne({
      unitCode: 'GHOTKI',
      role: 'zimmedar',
      ajeerCode: { $ne: '9090412' },
    }).lean())!.ajeerCode;
    await makeNewUser(noMobile);
  });

  it('asks for the registered mobile, without counting it as a failed login', async () => {
    for (let i = 0; i < 6; i += 1) {
      const res = await login({ ajeerCode: '9000001', password: '123' }).expect(401);
      expect(res.body.error.code).toBe('MOBILE_REQUIRED');
    }
  });

  it('rejects a mobile that does not match', async () => {
    const res = await login({
      ajeerCode: '9000001',
      password: '123',
      mobile: '03009999999',
    }).expect(401);
    expect(res.body.error.code).toBe('MOBILE_MISMATCH');
  });

  it('without a number on record, keeps the typed one as "tasdeeq baqi" for the District', async () => {
    const bad = await login({ ajeerCode: noMobile, password: '123', mobile: '12345' }).expect(400);
    expect(bad.body.error.details.field).toBe('mobile');

    await login({ ajeerCode: noMobile, password: '123', mobile: '0301 2223344' }).expect(200);
    const saved = await User.findOne({ ajeerCode: noMobile }).lean();
    expect(saved).toMatchObject({ mobile: '03012223344', mobileVerified: false });
    expect(
      await AuditLog.countDocuments({ action: 'MOBILE_SELF_REGISTER', actorAjeerCode: noMobile }),
    ).toBe(1);
    // From now on that number is the one checked.
    const other = await login({ ajeerCode: noMobile, password: '123', mobile: '03009999999' });
    expect(other.status).toBe(401);

    // The District sees it as unverified and confirms it (audited).
    const district = await loginCookie(app, '9040001');
    const list = await request(app)
      .get('/api/v1/users?mobileStatus=unverified')
      .set('Cookie', district)
      .expect(200);
    const row = (list.body.users as { id: string; ajeerCode: string; mobileStatus: string }[]).find(
      (u) => u.ajeerCode === noMobile,
    );
    expect(row?.mobileStatus).toBe('unverified');
    await request(app)
      .post(`/api/v1/users/${row!.id}/confirm-mobile`)
      .set('Cookie', district)
      .expect(200);
    expect((await User.findOne({ ajeerCode: noMobile }).lean())?.mobileVerified).toBe(true);
    expect(await AuditLog.countDocuments({ action: 'MOBILE_CONFIRM' })).toBe(1);
  });

  it('logs in when the mobile matches (any common format) and forces a password change', async () => {
    const res = await login({
      ajeerCode: '9000001',
      password: '123',
      mobile: '+92 300-1112233',
    }).expect(200);
    expect(res.body.user.mustChangePassword).toBe(true);
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;

    // Everything except me / change-password is closed until the password is changed.
    const blocked = await request(app).get('/api/v1/meta').set('Cookie', cookie).expect(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await request(app).get('/api/v1/auth/me').set('Cookie', cookie).expect(200);

    const change = (newPassword: string) =>
      request(app)
        .post('/api/v1/auth/change-password')
        .set('Cookie', cookie)
        .send({ currentPassword: '123', newPassword });

    expect((await change('123').expect(400)).body.error.code).toBe('VALIDATION_FAILED'); // too short
    expect((await change('12345').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await change('9000001').expect(400)).body.error.details.reason).toBe(
      'EQUALS_AJEER_CODE',
    );
    await change('abc123').expect(200);

    await request(app).get('/api/v1/meta').set('Cookie', cookie).expect(200);
    const again = await login({ ajeerCode: '9000001', password: 'abc123' }).expect(200);
    expect(again.body.user.mustChangePassword).toBe(false);
  });
});

describe('forgot password → district reset', () => {
  let arifId: string;
  let larkanaUserId: string;

  beforeAll(async () => {
    await seedDemo({ reset: true });
    arifId = String((await User.findOne({ ajeerCode: '9090412' }).lean())!._id);
    larkanaUserId = String(
      (await User.findOne({ role: 'zimmedar', unitCode: 'LARKANA_DIST' }).lean())!._id,
    );
  });

  it('answers the same whether or not the details match, and only matches open a request', async () => {
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ ajeerCode: '9090412', mobile: '03119999999' })
      .expect(200);
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ ajeerCode: '55555', mobile: '03000000000' })
      .expect(200);
    expect(await PasswordResetRequest.countDocuments()).toBe(0);

    for (let i = 0; i < 2; i += 1) {
      await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ ajeerCode: '9090412', mobile: '0300 0000000' })
        .expect(200);
    }
    expect(await PasswordResetRequest.countDocuments({ status: 'pending' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'PASSWORD_RESET_REQUEST' })).toBe(1);
  });

  it('shows the request to the district (and above), not to other districts', async () => {
    const district = await loginCookie(app, '9040001');
    const res = await request(app)
      .get('/api/v1/users/reset-requests')
      .set('Cookie', district)
      .expect(200);
    expect(res.body.requests).toEqual([
      expect.objectContaining({ ajeerCode: '9090412', userId: arifId, unitCode: 'GHOTKI' }),
    ]);

    const other = await User.findOne({
      role: 'zimmedar',
      unitCode: 'GHOTKI',
      ajeerCode: { $ne: '9090412' },
    }).lean();
    const zimmedar = await loginCookie(app, other!.ajeerCode);
    await request(app).get('/api/v1/users/reset-requests').set('Cookie', zimmedar).expect(403);
  });

  it('district resets: password back to 123, change forced, request closed, audited', async () => {
    const district = await loginCookie(app, '9040001');
    await request(app)
      .post(`/api/v1/users/${arifId}/reset-password`)
      .set('Cookie', district)
      .expect(200);

    expect(await PasswordResetRequest.countDocuments({ status: 'pending' })).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'PASSWORD_RESET', targetId: arifId })).toBe(1);

    await login({ ajeerCode: '9090412', password: 'demo1234' }).expect(401);
    const res = await login({
      ajeerCode: '9090412',
      password: '123',
      mobile: '03000000000',
    }).expect(200);
    expect(res.body.user.mustChangePassword).toBe(true);
  });

  it('district can reset directly (no request), but only its own lower-level users', async () => {
    const district = await loginCookie(app, '9040001');
    await request(app)
      .post(`/api/v1/users/${larkanaUserId}/reset-password`)
      .set('Cookie', district)
      .expect(404);

    const division = await loginCookie(app, '9030001');
    const district40001 = String((await User.findOne({ ajeerCode: '9040001' }).lean())!._id);
    await request(app)
      .post(`/api/v1/users/${district40001}/reset-password`)
      .set('Cookie', division)
      .expect(200);

    const self = String((await User.findOne({ ajeerCode: '9030001' }).lean())!._id);
    await request(app)
      .post(`/api/v1/users/${self}/reset-password`)
      .set('Cookie', division)
      .expect(403);
  });
});
