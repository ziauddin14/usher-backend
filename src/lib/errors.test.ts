import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from './errors.js';

/** An app whose only route fails with `err`. */
function failingApp(err: Error) {
  const app = express();
  app.get('/x', () => {
    throw err;
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('a database that cannot be reached → 503 DB_UNAVAILABLE (not a generic 500)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const name of ['MongooseServerSelectionError', 'MongoNetworkError']) {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:27017');
      err.name = name;
      const res = await request(failingApp(err)).get('/x').expect(503);
      expect(res.body.error.code).toBe('DB_UNAVAILABLE');
    }
    log.mockRestore();
  });

  it('any other unexpected error stays 500 INTERNAL', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(failingApp(new Error('boom')))
      .get('/x')
      .expect(500);
    expect(res.body.error.code).toBe('INTERNAL');
    log.mockRestore();
  });
});
