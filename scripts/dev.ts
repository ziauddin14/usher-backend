// Local development server: `pnpm dev` → http://localhost:4000/api/v1/health
import app from '../src/index.js';
import { env } from '../src/lib/env.js';
import { keepAliveBehindProxy } from '../src/lib/keep-alive.js';

const port = env().PORT;
keepAliveBehindProxy(
  app.listen(port, () => {
    console.warn(`ushr-demo-api listening on http://localhost:${port}/api/v1/health`);
  }),
);
