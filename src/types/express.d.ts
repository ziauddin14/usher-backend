import type { AuthUser } from '../lib/auth.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. */
      user?: AuthUser;
    }
  }
}

export {};
