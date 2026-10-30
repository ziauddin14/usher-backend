import { randomUUID } from 'node:crypto';
import { afterAll, inject } from 'vitest';
import { disconnectDb } from '../src/lib/db.js';
import { resetEnvCache } from '../src/lib/env.js';

// Each test file: its own database on the shared in-memory server.
const base = inject('mongoUri').replace(/\/?$/, '/');
process.env.MONGODB_URI = `${base}ushr_test_${randomUUID().slice(0, 8)}`;
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.NODE_ENV = 'test';
resetEnvCache();

afterAll(async () => {
  await disconnectDb();
});
