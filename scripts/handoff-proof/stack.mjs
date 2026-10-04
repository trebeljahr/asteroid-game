#!/usr/bin/env node
/**
 * Manual two-replica stack for browser testing of match handoff:
 * a fresh database, two server replicas, a round-robin proxy and the
 * production client server (client/server.mjs) in front of the proxy.
 *
 *   PROOF_DATABASE_URL=… PROOF_REDIS_URL=… node scripts/handoff-proof/stack.mjs
 *
 * Prints the client URL and each replica's PID. Drain a replica with
 * `kill -TERM <pid>`; this script restarts it after it exits. Ctrl-C
 * stops everything and drops the database.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startRoundRobinProxy } from "./rr-proxy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { Pool } = createRequire(path.join(root, "server/package.json"))("pg");
const adminUrl = process.env.PROOF_DATABASE_URL;
const redisUrl = process.env.PROOF_REDIS_URL;
if (!adminUrl || !redisUrl) {
  console.error("Set PROOF_DATABASE_URL and PROOF_REDIS_URL.");
  process.exit(2);
}

const freePort = async () => {
  for (;;) {
    const port = randomInt(49152, 65536);
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
};

const dbName = `asteroid_stack_${randomBytes(4).toString("hex")}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
await admin.query(`CREATE DATABASE ${dbName}`);
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;

const children = new Set();
let stopping = false;
const startReplica = (name, port) => {
  const child = spawn(process.execPath, ["server/dist/server/src/server.js"], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl.toString(),
      NODE_ENV: "production",
      PORT: String(port),
      REDIS_URL: redisUrl,
      REPLICA_ID: name,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.add(child);
  console.log(`[stack] replica ${name} pid ${child.pid} port ${port}`);
  child.on("exit", () => {
    children.delete(child);
    if (!stopping) setTimeout(() => startReplica(name, port), 1000);
  });
};

const ports = [await freePort(), await freePort()];
startReplica("A", ports[0]);
await new Promise((resolve) => setTimeout(resolve, 3000));
startReplica("B", ports[1]);
const proxyPort = await freePort();
const proxy = await startRoundRobinProxy(proxyPort, ports);
const clientPort = await freePort();
const client = spawn(process.execPath, ["server.mjs"], {
  cwd: path.join(root, "client"),
  env: {
    ...process.env,
    BACKEND_URL: `http://127.0.0.1:${proxyPort}`,
    NODE_ENV: "production",
    PORT: String(clientPort),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
children.add(client);
console.log(
  `[stack] client http://127.0.0.1:${clientPort} → proxy ${proxyPort} → ${ports.join(", ")}`,
);

const stop = async () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGKILL");
  await proxy.close().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
