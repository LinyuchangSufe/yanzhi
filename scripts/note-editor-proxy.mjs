// Disposable loopback-only latency fixture for browser testing of pending uploads
// and cancelled paper creation. No user library or external service is contacted.
import http from "node:http";

const port = 3116;
const targetPort = 3115;
const delayMs = 6000;
const server = http.createServer(async (request, response) => {
  const expectedHost = `127.0.0.1:${port}`;
  if (request.headers.host !== expectedHost || !request.url?.startsWith("/")) {
    response.writeHead(403).end();
    return;
  }
  const origin = request.headers.origin;
  if (origin && origin !== `http://${expectedHost}`) {
    response.writeHead(403).end();
    return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 105 * 1024 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    const action = request.url === "/api/kb" && request.method === "POST"
      ? JSON.parse(body.toString("utf8")).action : undefined;
    const delayed = request.method === "POST" &&
      (request.url === "/api/kb/image" || action === "paper.create");
    const headers = { ...request.headers, host: `127.0.0.1:${targetPort}` };
    delete headers.connection;
    if (origin) headers.origin = `http://127.0.0.1:${targetPort}`;
    const remote = http.request({
      host: "127.0.0.1", port: targetPort, path: request.url,
      method: request.method, headers,
    }, async (upstream) => {
      const parts = [];
      for await (const part of upstream) parts.push(part);
      const content = Buffer.concat(parts);
      if (delayed) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (response.destroyed) return;
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      response.end(content);
    });
    remote.on("error", () => { if (!response.destroyed) response.writeHead(502).end(); });
    remote.end(body);
  } catch {
    if (!response.destroyed) response.writeHead(400).end();
  }
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Note-editor latency fixture: http://127.0.0.1:${port}, target ${targetPort}, selected POST responses +${delayMs}ms\n`);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => server.close(() => process.exit(0)));
