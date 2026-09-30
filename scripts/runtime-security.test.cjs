const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { createRequire } = require("node:module");
const path = require("node:path");
const { test } = require("node:test");

const serverRequire = createRequire(path.join(__dirname, "../server/package.json"));
const clientRequire = createRequire(path.join(__dirname, "../client/package.json"));
const express = serverRequire("express");
const { Server } = serverRequire("socket.io");
const { io: connect } = clientRequire("socket.io-client");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("Express preserves JSON parsing and its default body limit", { timeout: 5000 }, async (t) => {
  const app = express();
  app.use(express.json());
  app.post("/echo", (req, res) => res.json(req.body));
  app.use((err, _req, res, _next) => res.sendStatus(err.status || 500));
  const server = createServer(app);
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const url = await listen(server);
  const post = (body) => fetch(`${url}/echo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const valid = await post(JSON.stringify({ movement: { x: 1, y: 2 } }));
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { movement: { x: 1, y: 2 } });
  assert.equal((await post("{")).status, 400);
  assert.equal((await post(JSON.stringify({ data: "x".repeat(110 * 1024) }))).status, 413);
});

for (const transport of ["polling", "websocket"]) {
  test(`Socket.IO ${transport} round-trip and payload limit`, { timeout: 5000 }, async (t) => {
    const server = createServer();
    const io = new Server(server, { maxHttpBufferSize: 1024 });
    io.on("connection", (socket) => socket.on("echo", (payload, ack) => ack(payload)));
    let client;
    t.after(() => new Promise((resolve) => {
      client?.disconnect();
      io.close(resolve);
    }));
    const url = await listen(server);
    client = connect(url, { transports: [transport], reconnection: false, timeout: 1500 });
    await Promise.race([
      once(client, "connect"),
      once(client, "connect_error").then(([error]) => Promise.reject(error)),
    ]);
    const payload = { movement: { x: 3, y: 4 } };
    assert.deepEqual(await client.timeout(1500).emitWithAck("echo", payload), payload);
    const disconnected = once(client, "disconnect");
    client.emit("echo", "x".repeat(2048));
    await disconnected;
    assert.equal(client.connected, false);
  });
}
