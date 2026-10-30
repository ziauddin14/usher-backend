import mongoose from 'mongoose';
import { env } from './env.js';

// One connection per warm serverless instance: cache the promise on globalThis.
const globalForDb = globalThis as typeof globalThis & {
  __ushrMongo?: Promise<typeof mongoose>;
};

export function connectDb(): Promise<typeof mongoose> {
  if (!globalForDb.__ushrMongo) {
    globalForDb.__ushrMongo = mongoose
      .connect(env().MONGODB_URI, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 5000,
        autoIndex: true,
      })
      .catch((error: unknown) => {
        // Allow the next request to retry instead of caching a failed connection.
        globalForDb.__ushrMongo = undefined;
        throw error;
      });
  }
  return globalForDb.__ushrMongo;
}

export async function disconnectDb(): Promise<void> {
  globalForDb.__ushrMongo = undefined;
  await mongoose.disconnect();
}

/** True when the database answers a ping within the timeout. */
export async function pingDb(): Promise<boolean> {
  try {
    const conn = await connectDb();
    const db = conn.connection.db;
    if (!db) return false;
    await db.admin().ping();
    return true;
  } catch {
    return false;
  }
}
