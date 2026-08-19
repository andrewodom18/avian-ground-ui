import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const client = join(root, "dist", "client");
const output = join(root, "ground-dist");

await Promise.all(
  ["dist", ".vinext", ".next"].map((directory) =>
    rm(join(root, directory), { recursive: true, force: true }),
  ),
);
await runBuild();

const temporary = await mkdtemp(join(root, ".ground-dist-"));

try {
  await cp(client, temporary, { recursive: true });
  const workerUrl = pathToFileURL(join(root, "dist", "server", "index.js"));
  workerUrl.searchParams.set("export", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  if (!response.ok) throw new Error(`dashboard render failed with HTTP ${response.status}`);
  const html = await response.text();
  const forbiddenReference = html.match(/\/@id\/|\/app\/globals\.css|\/Users\/|file:\/\//)
    ?? (html.includes(root) ? [root] : null);
  if (forbiddenReference) {
    throw new Error(`dashboard export contains a development-only asset or source path: ${forbiddenReference[0]}`);
  }
  if (!html.includes("AVIAN Ground | Operations")) {
    throw new Error("dashboard export is missing its expected title");
  }
  await writeFile(join(temporary, "index.html"), html, "utf8");
  await writeFile(
    join(temporary, "build.json"),
    `${JSON.stringify({ schema_version: 1, generated_at: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  await rm(output, { recursive: true, force: true });
  await rename(temporary, output);
  const exported = await readFile(join(output, "index.html"), "utf8");
  if (exported.length < 1_000) throw new Error("dashboard export is unexpectedly small");
  console.log(`Exported ground dashboard to ${output}`);
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}

async function runBuild() {
  const npmEntrypoint = process.env.npm_execpath;
  const command = npmEntrypoint ? process.execPath : "npm";
  const args = npmEntrypoint ? [npmEntrypoint, "run", "build"] : ["run", "build"];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`dashboard build failed (${signal ?? `exit ${code}`})`));
    });
  });
}
