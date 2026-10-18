import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { Server } from "socket.io";
import { io } from "../../client/node_modules/socket.io-client";
import { wireParser as clientWireParser } from "../../client/src/netcode/wireParser";
import { wireParser as serverWireParser } from "../src/realtime/wireParser";

const snapshot = {
  countdownMs: 0,
  matchId: "br-match-0b9d4c1e-7f1a-4a43-9b0e-3c2d5e6f7a8b",
  phase: "active",
  players: [
    {
      angle: -2.0943951023931953,
      ammo: 7,
      damageRecoveryTicks: 0,
      health: 4,
      id: "p-1f2e3d4c5b6a7980",
      lastInputSeq: 1234,
      shipVariant: "orbit-dart",
      slot: "alpha",
      thrusting: true,
      vx: 3.3333333333333335,
      vy: -0.000123456789,
      x: 1201.4999999999998,
      y: -733.25,
    },
  ],
  sequence: 98765,
  survivorsRemaining: 1,
};

// A client that cannot decode the server's frames never sees the snapshot: time out, not hang.
const roundTrip = { timeout: 5000 };

test(
  "the server sends msgpack and reads JSON, and the client is its mirror",
  roundTrip,
  async (t) => {
    const httpServer = createServer();
    const server = new Server(httpServer, { parser: serverWireParser, transports: ["websocket"] });
    server.on("connection", (socket) => {
      socket.on("echo", (payload, ack) => ack(payload));
      socket.emit("br:snapshot", snapshot);
    });
    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");
    const { port } = httpServer.address() as AddressInfo;

    const client = io(`http://127.0.0.1:${port}`, {
      parser: clientWireParser,
      reconnection: false,
      transports: ["websocket"],
    });
    t.after(() => {
      client.disconnect();
      server.close();
    });

    const frames: unknown[] = [];
    client.io.on("open", () => {
      client.io.engine.on("packet", (packet: { data?: unknown; type: string }) => {
        if (packet.type === "message") frames.push(packet.data);
      });
    });

    const [received] = await once(client, "br:snapshot");
    assert.deepEqual(received, snapshot, "every value survives, floats bit for bit");
    assert.deepEqual(await client.timeout(2000).emitWithAck("echo", snapshot), snapshot);
    assert.ok(frames.length >= 2, "the snapshot and the ack were seen on the wire");
    for (const frame of frames) {
      assert.ok(typeof frame !== "string", "the server sends binary frames");
    }
  },
);

test("the server never runs the msgpack decoder on what clients send", () => {
  // ext32 claiming 0xffffffff bytes: notepack.io would allocate and zero 4 GB.
  const frame = Buffer.from([0xc9, 0xff, 0xff, 0xff, 0xff, 0x00]);
  const decoder = new serverWireParser.Decoder();
  const startedAt = performance.now();
  assert.throws(() => decoder.add(frame));
  assert.ok(performance.now() - startedAt < 50, "rejected without decoding");
});
