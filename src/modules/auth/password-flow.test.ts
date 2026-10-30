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
  beforeAll(async () => {
    await seedDemo({ reset: true });
    await makeNewUser('90001', '03001112233');
    await makeNewUser('90002');
  });

  it('asks for the registered mobile, without counting it as a failed login', async () => {
    for (let i = 0; i < 6; i += 1) {
      const res = await login({ ajeerCode: '90001', password: '123' }).expect(401);
      expect(res.body.error.code).toBe('MOBILE_REQUIRED');
    }
  });

  it('rejects a mobile that does not match', async () => {
    const res = await login({ ajeerCode: '90001', password: '123', mobile: '03009999999' }).expect(
      401,
    );
    expect(res.body.error.code).toBe('MOBILE_MISMATCH');
  });

  it('refuses users without a registered mobile', async () => {
    const res = await login({ ajeerCode: '90002', password: '123', mobile: '03001112233' }).expect(
      403,
    );
    expect(res.body.error.code).toBe('MOBILE_NOT_REGISTERED');
  });

  it('logs in when the mobile matches (any common format) and forces a password change', async () => {
    const res = await login({
      ajeerCode: '90001',
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
    // A 5-digit ajeer code is already below the 6-character minimum.
    expect((await change('90001').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    await change('abc123').expect(200);

    await request(app).get('/api/v1/meta').set('Cookie', cookie).expect(200);
    const again = await login({ ajeerCode: '90001', password: 'abc123' }).expect(200);
    expect(again.body.user.mustChangePassword).toBe(false);
  });
});

describe('forgot password → district reset', () => {
  let arifId: string;
  let larkanaUserId: string;

  beforeAll(async () => {
    await seedDemo({ reset: true });
    arifId = String((await User.findOne({ ajeerCode: '90412' }).lean())!._id);
    larkanaUserId = String(
      (await User.findOne({ role: 'zimmedar', unitCode: 'LARKANA_DIST' }).lean())!._id,
    );
  });

  it('answers the same whether or not the details match, and only matches open a request', async () => {
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ ajeerCode: '90412', mobile: '03119999999' })
      .expect(200);
    await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ ajeerCode: '55555', mobile: '03000000000' })
      .expect(200);
    expect(await PasswordResetRequest.countDocuments()).toBe(0);

    for (let i = 0; i < 2; i += 1) {
      await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ ajeerCode: '90412', mobile: '0300 0000000' })
        .expect(200);
    }
    expect(await PasswordResetRequest.countDocuments({ status: 'pending' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'PASSWORD_RESET_REQUEST' })).toBe(1);
  });

  it('shows the request to the district (and above), not to other districts', async () => {
    const district = await loginCookie(app, '40001');
    const res = await request(app)
      .get('/api/v1/users/reset-requests')
      .set('Cookie', district)
      .expect(200);
    expect(res.body.requests).toEqual([
      expect.objectContaining({ ajeerCode: '90412', userId: arifId, unitCode: 'GHOTKI' }),
    ]);

    const other = await User.findOne({
      role: 'zimmedar',
      unitCode: 'GHOTKI',
      ajeerCode: { $ne: '90412' },
    }).lean();
    const zimmedar = await loginCookie(app, other!.ajeerCode);
    await request(app).get('/api/v1/users/reset-requests').set('Cookie', zimmedar).expect(403);
  });

  it('district resets: password back to 123, change forced, request closed, audited', async () => {
    const district = await loginCookie(app, '40001');
    await request(app)
      .post(`/api/v1/users/${arifId}/reset-password`)
      .set('Cookie', district)
      .expect(200);

    expect(await PasswordResetRequest.countDocuments({ status: 'pending' })).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'PASSWORD_RESET', targetId: arifId })).toBe(1);

    await login({ ajeerCode: '90412', password: 'demo1234' }).expect(401);
    const res = await login({ ajeerCode: '90412', password: '123', mobile: '03000000000' }).expect(
      200,
    );
    expect(res.body.user.mustChangePassword).toBe(true);
  });

  it('district can reset directly (no request), but only its own lower-level users', async () => {
    const district = await loginCookie(app, '40001');
    await request(app)
      .post(`/api/v1/users/${larkanaUserId}/reset-password`)
      .set('Cookie', district)
      .expect(404);

    const division = await loginCookie(app, '30001');
    const district40001 = String((await User.findOne({ ajeerCode: '40001' }).lean())!._id);
    await request(app)
      .post(`/api/v1/users/${district40001}/reset-password`)
      .set('Cookie', division)
      .expect(200);

    const self = String((await User.findOne({ ajeerCode: '30001' }).lean())!._id);
    await request(app)
      .post(`/api/v1/users/${self}/reset-password`)
      .set('Cookie', division)
      .expect(403);
  });
});
