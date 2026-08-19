import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the AVIAN operations shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>AVIAN Ground \| Operations<\/title>/i);
  assert.match(html, /Operations overview/);
  assert.match(html, /Auto refresh 10s/i);
  assert.match(html, /Synchronized aircraft telemetry/i);
  assert.match(html, /Mesh refresh 2s/i);
  assert.match(html, /Waiting for AVIAN mesh telemetry/i);
  assert.match(html, /Aircraft feed/i);
  assert.match(html, /active warning/i);
  assert.match(html, /Event filters/i);
  assert.match(html, /Message or service/i);
  assert.match(html, /Severity/i);
  assert.match(html, /All services/i);
  assert.match(html, /Newest first/i);
  assert.match(html, /aria-label="Event pages"/i);
  assert.match(html, /Previous/i);
  assert.match(html, /Next/i);
  assert.doesNotMatch(html, /updated never|additional warnings/i);
  assert.doesNotMatch(html, />MAVLink</i);
  assert.match(html, /observational only/i);
  assert.doesNotMatch(html, /emergency rtl|return to launch/i);
});

test("ground export is self-contained and omits command controls and source paths", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const html = await readFile(join(root, "ground-dist", "index.html"), "utf8");
  assert.ok((await stat(join(root, "ground-dist", "_next"))).isDirectory());
  await access(join(root, "ground-dist", "build.json"));
  assert.doesNotMatch(html, /\/Users\/|\/@id\/|\/app\/globals\.css/);
  assert.doesNotMatch(html, /emergency rtl|return to launch|issue command/i);
  assert.match(html, /metadata only/i);
});
