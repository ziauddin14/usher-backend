import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../index.js';
import { env, resetEnvCache, trustProxyHops } from './env.js';

describe('production environment guard', () => {
  const base = { JWT_SECRET: 'x'.repeat(40) };
  const check = (vars: Record<string, string>) => {
    const saved = { ...process.env };
    Object.assign(process.env, base, vars);
    resetEnvCache();
    try {
      return env();
    } finally {
      for (const k of Object.keys(vars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      resetEnvCache();
    }
  };

  it('refuses a local database or an http origin in production only', () => {
    expect(() =>
      check({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://localhost:27017/ushr_demo' }),
    ).toThrow(/local database in production/);
    expect(() =>
      check({
        NODE_ENV: 'production',
        MONGODB_URI: 'mongodb+srv://u:p@c.example.net/ushr_demo',
        ALLOWED_ORIGIN: 'http://ushr-frontend.vercel.app',
      }),
    ).toThrow(/https/);
    expect(
      check({
        NODE_ENV: 'production',
        MONGODB_URI: 'mongodb+srv://u:p@c.example.net/ushr_demo',
        ALLOWED_ORIGIN: 'https://ushr-frontend.vercel.app',
      }).NODE_ENV,
    ).toBe('production');
    expect(check({ NODE_ENV: 'test', MONGODB_URI: 'mongodb://localhost:27017/x' }).NODE_ENV).toBe(
      'test',
    );
  });
});

describe('TRUST_PROXY_HOPS', () => {
  it('defaults to 1 and accepts 0–5 only', () => {
    expect(trustProxyHops({})).toBe(1);
    expect(trustProxyHops({ TRUST_PROXY_HOPS: '' })).toBe(1);
    expect(trustProxyHops({ TRUST_PROXY_HOPS: '2' })).toBe(2);
    for (const bad of ['-1', '6', '1.5', 'two']) {
      expect(() => trustProxyHops({ TRUST_PROXY_HOPS: bad })).toThrow(/TRUST_PROXY_HOPS/);
    }
  });

  it('createApp uses it; with 2 hops the client IP is the one Vercel reported', async () => {
    const before = process.env.TRUST_PROXY_HOPS;
    process.env.TRUST_PROXY_HOPS = '2';
    try {
      expect(createApp().get('trust proxy')).toBe(2);
      const probe = express();
      probe.set('trust proxy', trustProxyHops());
      probe.get('/ip', (req, res) => {
        res.json({ ip: req.ip });
      });
      // Client 203.0.113.7 → Vercel (198.51.100.1) → Render proxy → API.
      const res = await request(probe)
        .get('/ip')
        .set('X-Forwarded-For', '203.0.113.7, 198.51.100.1')
        .expect(200);
      expect(res.body.ip).toBe('203.0.113.7');
    } finally {
      if (before === undefined) delete process.env.TRUST_PROXY_HOPS;
      else process.env.TRUST_PROXY_HOPS = before;
    }
  });
});
