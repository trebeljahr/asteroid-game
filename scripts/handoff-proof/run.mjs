#!/usr/bin/env node
/**
 * Multi-process proof for durable match handoff.
 *
 * Starts two built server processes on one Postgres and one Redis behind
 * a round-robin TCP proxy (no sticky sessions), drives simulated
 * WebSocket-only clients through it, and checks:
 *
 *   overlap   no cross-match delivery, shared queue, one lobby countdown
 *   duel      SIGTERM handoff of an active 1v1, resumed within bounds
 *   br        SIGTERM handoff of an active battle royale
 *   stale     owner paused past the lease TTL: a claim wins, stale writes are fenced
 *   kill      SIGKILL owner: resume from the last periodic snapshot
 *   abandon   SIGKILL owner and nobody returns: clean uncounted end
 *
 * Usage (build first with `pnpm build`):
 *   PROOF_DATABASE_URL=postgres://user:pass@127.0.0.1:PORT/db \
 *   PROOF_REDIS_URL=redis://127.0.0.1:PORT \
 *   node scripts/handoff-proof/run.mjs [scenario ...]
 *
 * PROOF_DATABASE_URL must allow CREATE DATABASE; a fresh database is
 * created and dropped. Ports are random in 49152–65535.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startRoundRobinProxy } from "./rr-proxy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverRequire = createRequire(path.join(root, "server/package.json"));
const clientRequire = createRequire(path.join(root, "client/package.json"));
const { Pool } = serverRequire("pg");
const { io: connect } = clientRequire("socket.io-client");

const adminUrl = process.env.PROOF_DATABASE_URL;
const redisUrl = process.env.PROOF_REDIS_URL;
if (!adminUrl || !redisUrl) {
  console.error("Set PROOF_DATABASE_URL and PROOF_REDIS_URL (see header).");
  process.exit(2);
}
const logDir = process.env.PROOF_LOG_DIR ?? path.join(root, ".handoff-proof-logs");
mkdirSync(logDir, { recursive: true });

const LEASE_TTL_MS = 5000;
const RESUME_GRACE_MS = 10_000;
const DRAIN_DELAY_MS = 8000;
const PLAYER_MAX_SPEED = 8.8;
// The client's last snapshot can be up to two ticks older than the
// final snapshot the owner writes when it freezes the match.
const POSITION_TOLERANCE = PLAYER_MAX_SPEED * 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = async () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = randomInt(49152, 65536);
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("no free port");
};

const waitFor = async (label, check, timeoutMs, intervalMs = 100) => {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
};

const httpGet = (port, urlPath) => {
  return new Promise((resolve, reject) => {
    const req = request(
      { agent: false, host: "127.0.0.1", path: urlPath, port, headers: { connection: "close" } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ body, status: res.statusCode }));
      },
    );
    req.on("error", reject);
    req.end();
  });
};

// ---------------------------------------------------------------- replicas

class Replica {
  constructor(name, port, databaseUrl) {
    this.name = name;
    this.port = port;
    this.databaseUrl = databaseUrl;
    this.process = null;
    this.log = "";
    this.generation = 0;
  }

  async start() {
    this.generation++;
    const logPath = path.join(logDir, `${this.name}-${this.generation}.log`);
    const logStream = createWriteStream(logPath);
    this.logPath = logPath;
    this.log = "";
    const child = spawn(process.execPath, ["server/dist/server/src/server.js"], {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: this.databaseUrl,
        DRAIN_DELAY_MS: String(DRAIN_DELAY_MS),
        NODE_ENV: "production",
        PORT: String(this.port),
        REDIS_URL: redisUrl,
        REPLICA_ID: this.name,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (chunk) => {
      this.log += chunk.toString();
      logStream.write(chunk);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => logStream.end());
    this.process = child;
    await waitFor(
      `${this.name} health`,
      async () => {
        try {
          return (await httpGet(this.port, "/health")).status === 200;
        } catch {
          return false;
        }
      },
      30_000,
    );
    const match = /\[realtime\] replica (\S+):/.exec(this.log);
    this.replicaId = match?.[1];
    if (!this.log.includes("durable match handoff")) {
      throw new Error(`${this.name} did not start in durable mode:\n${this.log}`);
    }
  }

  signal(name) {
    this.process?.kill(name);
  }

  async waitExit(timeoutMs) {
    const child = this.process;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(timeoutMs).then(() => {
        throw new Error(`${this.name} did not exit`);
      }),
    ]);
  }
}

// ----------------------------------------------------------------- clients

/**
 * Behaves like the browser client: WebSocket only, queue over the
 * socket, and on migrating/disconnect/stall it reconnects and resumes
 * with matchId + resume token.
 */
class SimClient {
  constructor(name, proxyPort, { autoResume = true } = {}) {
    this.name = name;
    this.deviceToken = `proof-${name}-${randomBytes(4).toString("hex")}`;
    this.autoResume = autoResume;
    this.match = null;
    this.snapshotMatchIds = new Set();
    this.lastSnapshot = null;
    this.lastSnapshotAt = 0;
    this.lastSnapshotBeforeMigration = null;
    this.migrating = false;
    this.migratingSince = 0;
    this.resumed = [];
    this.ended = null;
    this.lobbyEvents = 0;
    this.inputSeq = 0;
    this.inputTimer = null;
    this.resumeTimer = null;
    this.resumeTimeouts = 0;
    this.thrust = false;
    this.socket = connect(`http://127.0.0.1:${proxyPort}`, {
      auth: { deviceToken: this.deviceToken },
      autoConnect: false,
      reconnectionDelay: 400,
      reconnectionDelayMax: 2000,
      timeout: 5000,
      transports: ["websocket"],
    });
    this.wire();
  }

  wire() {
    const socket = this.socket;
    socket.on("connect", () => {
      if (this.match !== null) this.beginMigration();
    });
    socket.on("connect_error", () => {
      if (!socket.active) setTimeout(() => socket.connect(), 400);
    });
    socket.on("disconnect", (reason) => {
      if (this.closed) return;
      if (reason === "io server disconnect") setTimeout(() => socket.connect(), 400);
      if (this.match !== null) this.beginMigration();
    });
    socket.on("match:migrating", (payload) => {
      if (this.match?.matchId === payload.matchId) this.beginMigration();
    });
    socket.on("match:found", (payload) => this.onFound("duel", payload));
    socket.on("br:match-found", (payload) => this.onFound("battle-royale", payload));
    socket.on("br:lobby", () => {
      this.lobbyEvents++;
    });
    const onSnapshot = (payload) => {
      this.snapshotMatchIds.add(payload.matchId);
      if (this.match === null || this.migrating || payload.matchId !== this.match.matchId) return;
      if (this.lastSnapshot !== null && payload.sequence <= this.lastSnapshot.sequence) return;
      this.lastSnapshot = payload;
      this.lastSnapshotAt = Date.now();
    };
    socket.on("match:snapshot", onSnapshot);
    socket.on("br:snapshot", onSnapshot);
    socket.on("match:resumed", (payload) => {
      if (this.match?.matchId !== payload.matchId || !this.migrating) return;
      this.resumed.push({
        at: Date.now(),
        before: this.lastSnapshotBeforeMigration,
        migratingSince: this.migratingSince,
        payload,
      });
      this.migrating = false;
      this.lastSnapshot = payload.snapshot;
      this.lastSnapshotAt = Date.now();
      clearInterval(this.resumeTimer);
      this.resumeTimer = null;
    });
    socket.on("match:ended", (payload) => this.onEnded(payload));
    socket.on("br:match-ended", (payload) => this.onEnded(payload));
  }

  async connect() {
    this.socket.connect();
    await waitFor(`${this.name} connect`, () => this.socket.connected, 10_000);
    this.stallTimer = setInterval(() => {
      if (
        this.match !== null &&
        !this.migrating &&
        this.lastSnapshot !== null &&
        Date.now() - this.lastSnapshotAt > 3000
      ) {
        this.beginMigration();
      }
    }, 250);
  }

  get transport() {
    return this.socket.io.engine?.transport?.name;
  }

  async queue(mode) {
    const result = await this.socket
      .timeout(5000)
      .emitWithAck("queue:join", { mode, shipVariant: "orbit-dart" });
    if (!result.enqueued) throw new Error(`${this.name} enqueue failed: ${result.reason}`);
  }

  async leave() {
    return this.socket.timeout(5000).emitWithAck("queue:leave");
  }

  onFound(mode, payload) {
    this.match = { ...payload, mode };
    this.ended = null;
    this.inputTimer = setInterval(() => this.sendInput(), 1000 / 60);
  }

  onEnded(payload) {
    if (this.match?.matchId !== payload.matchId) return;
    this.ended = { at: Date.now(), payload };
    this.stopMatchTimers();
  }

  stopMatchTimers() {
    clearInterval(this.inputTimer);
    clearInterval(this.resumeTimer);
    this.inputTimer = null;
    this.resumeTimer = null;
  }

  sendInput() {
    if (this.match === null || this.migrating || !this.socket.connected) return;
    if (this.lastSnapshot?.phase !== "active") return;
    const input = {
      fire: false,
      inputSeq: ++this.inputSeq,
      thrust: this.thrust,
      turnLeft: this.inputSeq % 90 < 20,
      turnRight: false,
    };
    this.socket.emit(this.match.mode === "duel" ? "match:input" : "br:input", input);
  }

  beginMigration() {
    if (!this.autoResume || this.match === null || this.ended !== null) return;
    if (!this.migrating) {
      this.migrating = true;
      this.migratingSince = Date.now();
      this.lastSnapshotBeforeMigration = this.lastSnapshot;
    }
    if (this.resumeTimer === null) {
      this.resumeTimer = setInterval(() => void this.tryResume(), 500);
    }
    void this.tryResume();
  }

  async tryResume() {
    if (!this.migrating || this.resumeInFlight || !this.socket.connected) return;
    this.resumeInFlight = true;
    try {
      const result = await this.socket.timeout(2000).emitWithAck("match:resume", {
        matchId: this.match.matchId,
        resumeToken: this.match.resumeToken,
      });
      this.resumeTimeouts = 0;
      if (result.status === "ended" || result.status === "unknown") {
        this.ended = { at: Date.now(), payload: { resume: result } };
        this.migrating = false;
        this.stopMatchTimers();
      }
    } catch {
      this.resumeTimeouts++;
      if (this.resumeTimeouts >= 2) {
        this.resumeTimeouts = 0;
        this.socket.disconnect();
        setTimeout(() => this.socket.connect(), 400);
      }
    } finally {
      this.resumeInFlight = false;
    }
  }

  close() {
    this.closed = true;
    this.stopMatchTimers();
    clearInterval(this.stallTimer);
    this.socket.disconnect();
  }
}

// ------------------------------------------------------------- harness

const results = [];
const check = (scenario, label, ok, detail = "") => {
  results.push({ detail, label, ok, scenario });
  console.log(`${ok ? "PASS" : "FAIL"} [${scenario}] ${label}${detail ? ` — ${detail}` : ""}`);
};

const playerMap = (snapshot) => new Map(snapshot.players.map((player) => [player.id, player]));

/** Max position delta and exact health/ammo equality between two snapshots. */
const compareSnapshots = (before, after) => {
  const a = playerMap(before);
  let maxDelta = 0;
  let vitalsEqual = true;
  for (const player of after.players) {
    const previous = a.get(player.id);
    if (previous === undefined) return { maxDelta: Infinity, vitalsEqual: false };
    maxDelta = Math.max(maxDelta, Math.hypot(player.x - previous.x, player.y - previous.y));
    vitalsEqual &&= player.health === previous.health && player.ammo === previous.ammo;
  }
  return { maxDelta, vitalsEqual };
};

const main = async () => {
  const scenarios = process.argv.slice(2);
  const want = (name) => scenarios.length === 0 || scenarios.includes(name);

  const dbName = `asteroid_proof_${randomBytes(4).toString("hex")}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${dbName}`);
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: dbUrl.toString(), max: 2 });

  const replicas = [
    new Replica("A", await freePort(), dbUrl.toString()),
    new Replica("B", await freePort(), dbUrl.toString()),
  ];
  // Start one first so migrations run once, then the second.
  await replicas[0].start();
  await replicas[1].start();
  const proxyPort = await freePort();
  const proxy = await startRoundRobinProxy(
    proxyPort,
    replicas.map((replica) => replica.port),
  );
  console.log(
    `replicas ${replicas.map((r) => `${r.name}=${r.replicaId}@${r.port}`).join(", ")}; proxy ${proxyPort}; db ${dbName}; logs ${logDir}`,
  );

  const clients = [];
  const newClient = async (name, options) => {
    const client = new SimClient(name, proxyPort, options);
    clients.push(client);
    await client.connect();
    return client;
  };
  const leaseOf = async (matchId) => {
    const { rows } = await pool.query("SELECT * FROM match_leases WHERE match_id = $1", [matchId]);
    return rows[0] ?? null;
  };
  const ownerReplica = async (matchId) => {
    const lease = await leaseOf(matchId);
    return replicas.find((replica) => replica.replicaId === lease?.owner_replica) ?? null;
  };
  const receipts = async (matchId) => {
    const { rows } = await pool.query("SELECT * FROM match_results WHERE match_id = $1", [matchId]);
    return rows;
  };
  const statsFor = async (client) => {
    const { rows } = await pool.query(
      `SELECT s.* FROM user_stats s JOIN users u ON u.id = s.user_id WHERE u.device_token = $1`,
      [client.deviceToken],
    );
    return rows[0];
  };
  const restartIfDown = async (replica) => {
    await replica.waitExit(DRAIN_DELAY_MS + 10_000).catch(() => {});
    await replica.start();
  };
  const waitActive = (group) =>
    waitFor(
      "active phase",
      () => group.every((client) => client.lastSnapshot?.phase === "active"),
      30_000,
    );

  try {
    // ---------------------------------------------------------- overlap
    if (want("overlap")) {
      const scenario = "overlap";
      const runtime = await Promise.all(
        [0, 1, 2, 3].map(() => httpGet(proxyPort, "/trpc/multiplayer.runtime")),
      );
      check(
        scenario,
        "tRPC through the round-robin proxy",
        runtime.every((response) => response.status === 200),
        runtime.map((response) => response.status).join(","),
      );

      const duelists = [];
      for (let index = 0; index < 4; index++) duelists.push(await newClient(`overlap-${index}`));
      check(
        scenario,
        "WebSocket-only connect through the proxy",
        duelists.every((client) => client.socket.connected && client.transport === "websocket"),
        duelists.map((client) => client.transport).join(","),
      );
      for (const client of duelists) await client.queue("duel");
      await waitFor("two duels", () => duelists.every((client) => client.match !== null), 10_000);
      const matchIds = new Set(duelists.map((client) => client.match.matchId));
      const owners = await Promise.all([...matchIds].map((id) => ownerReplica(id)));
      check(
        scenario,
        "shared queue paired 4 players into 2 matches",
        matchIds.size === 2,
        `owners ${owners.map((owner) => owner?.name).join(",")}`,
      );
      await sleep(3500);
      const crossed = duelists.filter((client) => {
        return [...client.snapshotMatchIds].some((id) => id !== client.match.matchId);
      });
      check(
        scenario,
        "no cross-match delivery",
        crossed.length === 0 && duelists.every((client) => client.snapshotMatchIds.size === 1),
        duelists.map((client) => client.snapshotMatchIds.size).join(","),
      );

      const lobbyClients = [await newClient("lobby-0"), await newClient("lobby-1")];
      for (const client of lobbyClients) await client.queue("battle-royale");
      await sleep(600);
      for (const client of lobbyClients) client.lobbyEvents = 0;
      await sleep(3000);
      // One owner emits at 4 Hz; two owners would double that.
      check(
        scenario,
        "one battle-royale lobby countdown across replicas",
        lobbyClients.every((client) => client.lobbyEvents >= 9 && client.lobbyEvents <= 15),
        `events in 3 s: ${lobbyClients.map((client) => client.lobbyEvents).join(",")}`,
      );
      for (const client of [...duelists, ...lobbyClients]) {
        await client.leave();
        client.close();
      }
      check(
        scenario,
        "proxy spread connections over both replicas",
        [...proxy.connections.values()].every((count) => count > 0),
        JSON.stringify(Object.fromEntries(proxy.connections)),
      );
    }

    // ------------------------------------------------- SIGTERM handoffs
    const handoff = async (scenario, mode, playerCount) => {
      const group = [];
      for (let index = 0; index < playerCount; index++) {
        group.push(await newClient(`${scenario}-${index}`));
      }
      for (const client of group) await client.queue(mode);
      await waitFor("match found", () => group.every((client) => client.match !== null), 30_000);
      const matchId = group[0].match.matchId;
      await waitActive(group);
      group[0].thrust = true;
      const startPosition = playerMap(group[0].lastSnapshot).get(group[0].match.playerId);
      await sleep(1200);
      const moved = playerMap(group[0].lastSnapshot).get(group[0].match.playerId);
      check(
        scenario,
        "ships move under client input before the handoff",
        Math.hypot(moved.x - startPosition.x, moved.y - startPosition.y) > 50,
        `moved ${Math.hypot(moved.x - startPosition.x, moved.y - startPosition.y).toFixed(1)} units`,
      );

      const owner = await ownerReplica(matchId);
      const leaseBefore = await leaseOf(matchId);
      const signalledAt = Date.now();
      owner.signal("SIGTERM");
      await waitFor(
        "all resumed",
        () => group.every((client) => client.resumed.length > 0),
        20_000,
      );
      const resumeMs = Math.max(...group.map((client) => client.resumed[0].at - signalledAt));
      const leaseAfter = await leaseOf(matchId);
      check(
        scenario,
        `SIGTERM handoff resumed all ${playerCount} players`,
        resumeMs < 10_000,
        `${resumeMs} ms after SIGTERM; owner ${owner.name} epoch ${leaseBefore.epoch} → ${leaseAfter.owner_replica} epoch ${leaseAfter.epoch}`,
      );
      check(
        scenario,
        "new owner is the other replica with a higher epoch",
        leaseAfter.owner_replica !== owner.replicaId &&
          Number(leaseAfter.epoch) === Number(leaseBefore.epoch) + 1,
      );
      const comparisons = group.map((client) => {
        return compareSnapshots(client.resumed[0].before, client.resumed[0].payload.snapshot);
      });
      const maxDelta = Math.max(...comparisons.map((entry) => entry.maxDelta));
      check(
        scenario,
        "resumed state within tolerance of the pre-handoff state",
        maxDelta <= POSITION_TOLERANCE && comparisons.every((entry) => entry.vitalsEqual),
        `max position delta ${maxDelta.toFixed(2)} (tolerance ${POSITION_TOLERANCE.toFixed(1)}), health/ammo equal`,
      );
      await waitFor(
        "active again",
        () => group.every((client) => client.lastSnapshot?.phase === "active"),
        15_000,
      );
      const resumedSequence = group[0].lastSnapshot.sequence;
      await sleep(1000);
      check(
        scenario,
        "simulation continues on the new owner",
        group[0].lastSnapshot.sequence > resumedSequence + 30 && !group[0].migrating,
        `sequence ${resumedSequence} → ${group[0].lastSnapshot.sequence}`,
      );

      // Finish: everyone but player 0 leaves; player 0 wins.
      for (const client of group.slice(1)) await client.leave();
      await waitFor("match ended", () => group[0].ended !== null, 10_000);
      await sleep(1500);
      const rows = await receipts(matchId);
      const winnerStats = await statsFor(group[0]);
      const expectedRows = mode === "duel" ? 1 : playerCount;
      const winsColumn = mode === "duel" ? "multiplayer_wins" : "br_wins";
      check(
        scenario,
        "result recorded once (receipts and stats)",
        rows.length === expectedRows && winnerStats[winsColumn] === 1,
        `${rows.length} receipts, winner ${winsColumn}=${winnerStats[winsColumn]}, lease ${(await leaseOf(matchId)).state}`,
      );
      for (const client of group) client.close();
      await restartIfDown(owner);
    };

    if (want("duel")) await handoff("duel", "duel", 2);
    if (want("br")) await handoff("br", "battle-royale", 3);

    // ------------------------------------------------------ stale epoch
    if (want("stale")) {
      const scenario = "stale";
      const group = [await newClient("stale-0"), await newClient("stale-1")];
      for (const client of group) await client.queue("duel");
      await waitFor("match", () => group.every((client) => client.match !== null), 10_000);
      const matchId = group[0].match.matchId;
      await waitActive(group);
      const owner = await ownerReplica(matchId);
      const other = replicas.find((replica) => replica !== owner);
      const leaseBefore = await leaseOf(matchId);
      owner.signal("SIGSTOP");
      const pausedAt = Date.now();
      const claimed = await waitFor(
        "claim by the other replica",
        async () => {
          const lease = await leaseOf(matchId);
          return lease?.owner_replica === other.replicaId ? lease : null;
        },
        LEASE_TTL_MS + 10_000,
      );
      check(
        scenario,
        "paused owner's lease claimed after TTL",
        Number(claimed.epoch) === Number(leaseBefore.epoch) + 1,
        `claimed ${Date.now() - pausedAt} ms after pause, epoch ${leaseBefore.epoch} → ${claimed.epoch}`,
      );
      await waitFor(
        "clients resumed on the new owner",
        () => group.every((client) => client.resumed.length > 0),
        RESUME_GRACE_MS + 5000,
      );
      await sleep(1500);
      owner.signal("SIGCONT");
      await sleep(3000);
      const snapshotRow = (
        await pool.query("SELECT epoch, sequence FROM match_snapshots WHERE match_id = $1", [
          matchId,
        ])
      ).rows[0];
      const fencedLog =
        owner.log.includes(`fenced snapshot write rejected for ${matchId}`) ||
        owner.log.includes(`lost lease for ${matchId}`);
      check(
        scenario,
        "stale owner's writes rejected after it resumes",
        fencedLog && Number(snapshotRow.epoch) === Number(claimed.epoch),
        `old owner log: ${owner.log.match(new RegExp(`\\[durability\\][^\\n]*${matchId}[^\\n]*`))?.[0]}; snapshot epoch ${snapshotRow.epoch}`,
      );
      await group[1].leave();
      await waitFor("ended", () => group[0].ended !== null, 10_000);
      await sleep(1500);
      const rows = await receipts(matchId);
      check(scenario, "result recorded once", rows.length === 1, `${rows.length} receipts`);
      for (const client of group) client.close();
    }

    // ------------------------------------------------------ SIGKILL
    if (want("kill")) {
      const scenario = "kill";
      const group = [await newClient("kill-0"), await newClient("kill-1")];
      for (const client of group) await client.queue("duel");
      await waitFor("match", () => group.every((client) => client.match !== null), 10_000);
      const matchId = group[0].match.matchId;
      await waitActive(group);
      group[1].thrust = true;
      await sleep(1500);
      const owner = await ownerReplica(matchId);
      owner.signal("SIGKILL");
      const killedAt = Date.now();
      const periodic = (
        await pool.query("SELECT epoch, sequence, state FROM match_snapshots WHERE match_id = $1", [
          matchId,
        ])
      ).rows[0];
      await waitFor("resumed", () => group.every((client) => client.resumed.length > 0), 25_000);
      const resumedPayload = group[0].resumed[0].payload;
      const expected = new Map(
        periodic.state.players.map((player) => [player.playerId, player.state]),
      );
      const exact = resumedPayload.snapshot.players.every((player) => {
        const stored = expected.get(player.id);
        return (
          stored &&
          stored.x === player.x &&
          stored.y === player.y &&
          stored.health === player.health
        );
      });
      check(
        scenario,
        "SIGKILL: resumed from the last periodic snapshot",
        exact,
        `resumed ${Math.max(...group.map((client) => client.resumed[0].at)) - killedAt} ms after kill from sequence ${periodic.sequence} (epoch ${periodic.epoch})`,
      );
      await group[1].leave();
      await waitFor("ended", () => group[0].ended !== null, 10_000);
      await sleep(1500);
      check(scenario, "result recorded once", (await receipts(matchId)).length === 1);
      for (const client of group) client.close();
      await owner.start();
    }

    if (want("abandon")) {
      const scenario = "abandon";
      const group = [
        await newClient("abandon-0", { autoResume: false }),
        await newClient("abandon-1", { autoResume: false }),
      ];
      for (const client of group) await client.queue("duel");
      await waitFor("match", () => group.every((client) => client.match !== null), 10_000);
      const matchId = group[0].match.matchId;
      await waitActive(group);
      const statsBefore = await Promise.all(group.map((client) => statsFor(client)));
      const owner = await ownerReplica(matchId);
      for (const client of group) client.close();
      owner.signal("SIGKILL");
      const killedAt = Date.now();
      const finished = await waitFor(
        "uncounted end",
        async () => ((await leaseOf(matchId))?.state === "finished" ? true : null),
        LEASE_TTL_MS + RESUME_GRACE_MS + 10_000,
        250,
      );
      const statsAfter = await Promise.all(group.map((client) => statsFor(client)));
      check(
        scenario,
        "SIGKILL with no returning players: clean uncounted end after grace",
        finished &&
          (await receipts(matchId)).length === 0 &&
          JSON.stringify(
            statsBefore.map((s) => [s.multiplayer_wins, s.multiplayer_losses, s.multiplayer_draws]),
          ) ===
            JSON.stringify(
              statsAfter.map((s) => [
                s.multiplayer_wins,
                s.multiplayer_losses,
                s.multiplayer_draws,
              ]),
            ),
        `lease finished ${Date.now() - killedAt} ms after kill, 0 receipts, stats unchanged`,
      );
      await owner.start();
    }
  } finally {
    for (const client of clients) client.close();
    for (const replica of replicas) {
      replica.signal("SIGCONT");
      replica.signal("SIGKILL");
    }
    await proxy.close().catch(() => {});
    await pool.end();
    await sleep(500);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
