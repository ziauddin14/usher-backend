// Production server (Render): `pnpm build && pnpm start` → node dist/server.js.
// Local development uses scripts/dev.ts (`pnpm dev`, tsx watch).
import app from './index.js';
import { env } from './lib/env.js';

const port = env().PORT;
app.listen(port, '0.0.0.0', () => {
  console.warn(`ushr-api listening on port ${port} (${env().NODE_ENV})`);
});
