import net from "node:net";

/**
 * Connection-level round-robin TCP proxy with no session affinity, like
 * a load balancer without sticky sessions. Each new TCP connection goes
 * to the next backend; a refused backend is skipped.
 */
export function startRoundRobinProxy(listenPort, backendPorts) {
  let next = 0;
  const connections = new Map(backendPorts.map((port) => [port, 0]));

  const server = net.createServer((client) => {
    const start = next;
    next = (next + 1) % backendPorts.length;
    client.on("error", () => {});

    const attempt = (offset) => {
      if (offset >= backendPorts.length) {
        client.destroy();
        return;
      }
      const port = backendPorts[(start + offset) % backendPorts.length];
      const upstream = net.connect(port, "127.0.0.1");
      let connected = false;
      upstream.once("connect", () => {
        connected = true;
        connections.set(port, connections.get(port) + 1);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => {
        if (!connected) {
          attempt(offset + 1);
          return;
        }
        client.destroy();
      });
      upstream.on("close", () => client.destroy());
      client.on("close", () => upstream.destroy());
    };
    attempt(0);
  });

  return new Promise((resolve) => {
    server.listen(listenPort, "127.0.0.1", () => {
      resolve({
        close: () => new Promise((done) => server.close(done)),
        connections,
        server,
      });
    });
  });
}
