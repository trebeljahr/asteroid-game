import { Redis } from "ioredis";

/**
 * Connect to REDIS_URL, waiting up to `timeoutMs`. Returns null when
 * Redis is not configured or not reachable; the server then runs as a
 * single replica. Waiting matters: the Socket.IO adapter and the
 * replica bus must be installed before the server accepts sockets.
 */
export async function connectRedis(timeoutMs = 5000): Promise<Redis | null> {
  const url = process.env.REDIS_URL;
  if (!url || process.env.NODE_ENV === "test") {
    return null;
  }

  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      return Math.min(times * 500, 5000);
    },
    lazyConnect: true,
  });

  let errorLogged = false;
  client.on("connect", () => {
    errorLogged = false;
    console.log("[redis] Connected");
  });
  client.on("error", () => {
    if (!errorLogged) {
      errorLogged = true;
      console.error("[redis] Connection error, retrying in background...");
    }
  });

  try {
    await Promise.race([
      client.connect(),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("timeout")), timeoutMs).unref();
      }),
    ]);
    return client;
  } catch {
    console.error("[redis] Not reachable at startup; running as a single replica");
    client.disconnect();
    return null;
  }
}
