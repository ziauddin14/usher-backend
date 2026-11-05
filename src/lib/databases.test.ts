import { describe, expect, it } from 'vitest';
import {
  assertDemoDb,
  dbNameOf,
  isLiveDb,
  liveDbUri,
  seedRefusal,
  withDbName,
} from './databases.js';

describe('databases', () => {
  it('reads and replaces the database name', () => {
    expect(dbNameOf('mongodb://localhost:27017/ushr_demo')).toBe('ushr_demo');
    expect(dbNameOf('mongodb+srv://u:p@c.example.net/ushr_live?retryWrites=true')).toBe(
      'ushr_live',
    );
    expect(withDbName('mongodb+srv://u:p@c.example.net/ushr_demo?w=majority', 'ushr_live')).toBe(
      'mongodb+srv://u:p@c.example.net/ushr_live?w=majority',
    );
    expect(withDbName('mongodb://localhost:27017', 'ushr_live')).toBe(
      'mongodb://localhost:27017/ushr_live',
    );
  });

  it('imports go only to a live database', () => {
    expect(isLiveDb('mongodb://localhost:27017/ushr_demo')).toBe(false);
    expect(liveDbUri({ MONGODB_URI: 'mongodb://localhost:27017/ushr_demo' })).toBe(
      'mongodb://localhost:27017/ushr_live',
    );
    expect(() => liveDbUri({ LIVE_MONGODB_URI: 'mongodb://localhost:27017/ushr_demo' })).toThrow(
      /live database/,
    );
  });

  it('the seed never touches a live database and --reset always needs SEED_CONFIRM', () => {
    const demo = 'mongodb://localhost:27017/ushr_demo';
    const atlas = 'mongodb+srv://u:p@c.example.net/ushr_demo?w=majority';
    expect(seedRefusal('mongodb://localhost:27017/ushr_live', false, undefined)).toMatch(/live/);
    expect(seedRefusal('mongodb://localhost:27017/ushr_live', true, 'ushr_live')).toMatch(/live/);
    expect(seedRefusal(demo, false, undefined)).toBeNull();
    expect(seedRefusal(demo, true, undefined)).toMatch(/SEED_CONFIRM=ushr_demo/);
    expect(seedRefusal(demo, true, 'ushr_demo')).toBeNull();
    expect(seedRefusal(atlas, true, 'yes')).toMatch(/SEED_CONFIRM/);
    expect(seedRefusal(atlas, true, 'ushr_demo')).toBeNull();
    expect(() => assertDemoDb('mongodb://localhost:27017/ushr_live')).toThrow(/live/);
    expect(() => assertDemoDb(demo)).not.toThrow();
  });
});
