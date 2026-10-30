// Vercel zero-config entry: default-exports the Express app (no listen here).
// Local dev listens in scripts/dev.ts.
import cookieParser from 'cookie-parser';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import { env } from './lib/env.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { authRouter } from './modules/auth/routes.js';
import { healthRouter } from './modules/health/routes.js';
import { metaRouter } from './modules/meta/routes.js';
import { usersRouter } from './modules/users/routes.js';

/** CORS only for ALLOWED_ORIGIN (the browser normally reaches us through the Next.js rewrite). */
const cors: RequestHandler = (req, res, next) => {
  const origin = req.get('origin');
  if (origin && origin === env().ALLOWED_ORIGIN) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE');
      res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      res.status(204).end();
      return;
    }
  }
  next();
};

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  const api = express.Router();
  api.use('/health', healthRouter());
  api.use('/meta', metaRouter());
  api.use('/auth', authRouter());
  api.use('/users', usersRouter());
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const app = createApp();
export default app;
