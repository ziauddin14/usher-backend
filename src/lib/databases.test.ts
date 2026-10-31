import { describe, expect, it } from 'vitest';
import { dbNameOf, isLiveDb, liveDbUri, withDbName } from './databases.js';

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
});
