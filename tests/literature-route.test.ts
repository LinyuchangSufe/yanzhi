import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../src/app/api/kb/literature/route";
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3000/api/kb/literature", { method: "POST", headers: { host: "127.0.0.1:3000", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
test("literature route rejects cross-site requests, client metadata/tag injection and unsupported actions before any lookup or write", async () => {
  assert.equal((await POST(request({ action: "search", query: "TEST" }, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await POST(request({ action: "search", query: "TEST" }, { "content-type": "text/plain" }))).status, 415);
  for (const body of [
    { action: "search", query: "TEST", tags: ["FORGED"] },
    { action: "import", candidateToken: "forged", downloadPdf: false, metadata: { title: "FORGED" } },
    { action: "shell", command: "forbidden" },
    { action: "search", query: "TEST", context: { paperIds: ["not-a-uuid"] } },
  ]) {
    const response = await POST(request(body)); assert.equal(response.status, 400); assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
