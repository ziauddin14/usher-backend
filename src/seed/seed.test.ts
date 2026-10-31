import { beforeAll, describe, expect, it } from 'vitest';
import { Unit } from '../models/unit.js';
import { User } from '../models/user.js';
import { Village } from '../models/village.js';
import { seedDemo } from './seed.js';

describe('seedDemo', () => {
  beforeAll(async () => {
    await seedDemo({ reset: true });
  });

  it('creates the hierarchy with materialised paths', async () => {
    // 20 Interior Sindh districts (data model "Seed") + Gujrat.
    expect(await Unit.countDocuments({ level: 'district' })).toBe(21);
    expect(await Unit.countDocuments({ level: 'division' })).toBe(8);
    const ghotki = await Unit.findOne({ code: 'GHOTKI' }).lean();
    expect(ghotki?.path).toBe('PK/INT_SINDH/SUKKUR/GHOTKI');
    expect((await Unit.findOne({ code: 'GUJRAT_DIST' }).lean())?.path).toBe(
      'PK/PUNJAB/GUJRAT/GUJRAT_DIST',
    );
  });

  it('creates the 5 demo logins and ~60 invented zimmedaran', async () => {
    for (const code of ['9010001', '9020001', '9030001', '9040001', '9090412']) {
      expect(await User.exists({ ajeerCode: code })).toBeTruthy();
    }
    const zimmedaran = await User.countDocuments({ role: 'zimmedar' });
    expect(zimmedaran).toBeGreaterThanOrEqual(55);
    expect(zimmedaran).toBeLessThanOrEqual(80);
    expect(await User.countDocuments({ role: 'zimmedar', unitCode: 'GHOTKI' })).toBe(10);
  });

  it('seeds 8–15 villages per district', async () => {
    const perDistrict = await Village.aggregate<{ n: number }>([
      { $group: { _id: '$districtCode', n: { $sum: 1 } } },
    ]);
    expect(perDistrict).toHaveLength(21);
    expect(perDistrict.every((d) => d.n >= 8 && d.n <= 15)).toBe(true);
  });

  it('is idempotent and keeps changed passwords', async () => {
    await User.updateOne({ ajeerCode: '9040001' }, { $set: { passwordHash: 'changed' } });
    const before = { users: await User.countDocuments(), villages: await Village.countDocuments() };
    await seedDemo();
    expect(await User.countDocuments()).toBe(before.users);
    expect(await Village.countDocuments()).toBe(before.villages);
    const user = await User.findOne({ ajeerCode: '9040001' }).select('+passwordHash').lean();
    expect(user?.passwordHash).toBe('changed');
  });
});
