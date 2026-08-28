/**
 * Captures the README assets: four screenshots and an animated GIF of two
 * replicas diverging under a partition and reconciling when it heals.
 *
 * Everything recorded is the real app driven through its real UI, against a
 * real relay server, with the real CRDT doing the merging. Nothing is staged,
 * and the script aborts rather than capture a misleading frame.
 *
 *   node scripts/capture.mjs
 *
 * Requires a built editor (`npm run build -w @weave/editor`) and ffmpeg
 * on PATH for the GIF step. Without ffmpeg the screenshots and the raw webm
 * are still produced.
 */
import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { readFile, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "packages/editor/dist");
const ASSETS = join(ROOT, "assets");
const TMP = join(ROOT, "packages/editor/.capture");
const WIDTH = 1440;
const HEIGHT = 900;

/**
 * Ports are picked at run time rather than hard-coded. The documented default
 * (8787) is a popular one, and a collision here shows up as a "no server
 * found" banner burned into a screenshot — worse than no screenshot at all.
 */
function freePort() {
  return new Promise((ok, fail) => {
    const s = netServer();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function staticServer(root, port) {
  const server = createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    let file = join(root, url === "/" ? "index.html" : decodeURIComponent(url));
    if (!existsSync(file)) file = join(root, "index.html");
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

async function waitFor(fn, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

if (!existsSync(DIST)) {
  console.error("packages/editor/dist is missing. Run: npm run build -w @weave/editor");
  process.exit(1);
}

const WS_PORT = await freePort();
const HTTP_PORT = await freePort();

await mkdir(ASSETS, { recursive: true });
await rm(TMP, { recursive: true, force: true });

const relay = spawn("npx", ["tsx", "packages/server/src/index.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(WS_PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", (d) => process.stdout.write(`[relay] ${d}`));
relay.stderr.on("data", (d) => process.stderr.write(`[relay!] ${d}`));

const { WebSocket: NodeWS } = await import("ws");
await waitFor(
  () =>
    new Promise((ok) => {
      const probe = new NodeWS(`ws://127.0.0.1:${WS_PORT}`);
      probe.on("open", () => {
        probe.close();
        ok(true);
      });
      probe.on("error", () => ok(false));
    }),
  "relay server",
);
console.log(`relay up on ws://127.0.0.1:${WS_PORT}`);

const http = await staticServer(DIST, HTTP_PORT);
await waitFor(async () => {
  try {
    await fetch(`http://127.0.0.1:${HTTP_PORT}/`);
    return true;
  } catch {
    return false;
  }
}, "static server");

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
  colorScheme: "dark",
  recordVideo: { dir: TMP, size: { width: WIDTH, height: HEIGHT } },
});
const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.error(`[page] ${m.text()}`);
});

async function shutdown(code) {
  await ctx.close();
  await browser.close();
  http.close();
  relay.kill("SIGTERM");
  if (code !== undefined) process.exit(code);
}

/**
 * Screenshots only as far down as the content actually reaches. The app shell
 * fills the viewport, so a plain viewport shot leaves most of the image empty.
 */
async function shot(name) {
  const bottom = await page.evaluate(() => {
    // Only leaf elements count. Layout containers stretch to fill the viewport,
    // so including them measures the window rather than the content.
    let max = 0;
    for (const el of document.querySelectorAll("#root *")) {
      if (el.childElementCount > 0) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.width > 0 && r.bottom > max) max = r.bottom;
    }
    return Math.min(Math.ceil(max) + 28, window.innerHeight);
  });
  await page.screenshot({ path: join(ASSETS, name), clip: { x: 0, y: 0, width: WIDTH, height: bottom } });
  console.log(`captured ${name}`);
}

await page.goto(`http://127.0.0.1:${HTTP_PORT}/?server=ws://127.0.0.1:${WS_PORT}`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1500);

// A silent fall back to the in-browser loopback would produce screenshots that
// prove nothing about the networked path.
if (await page.getByText(/loopback mode/i).count()) {
  console.error("page fell back to loopback despite a live relay — refusing to capture");
  await shutdown(1);
}

// --- Collaborate ---------------------------------------------------------
const areas = page.locator("textarea");
await areas.first().waitFor({ timeout: 15_000 });
await areas.nth(0).click();
await areas.nth(0).type("Two people editing the same paragraph. ", { delay: 24 });
await page.waitForTimeout(400);
await areas.nth(1).click();
await areas.nth(1).type("Neither of them waits for the network.", { delay: 24 });
await page.waitForTimeout(1200);
await shot("collaborate.png");

// --- Anomaly Lab ---------------------------------------------------------
await page.getByRole("tab", { name: /anomaly/i }).or(page.getByText(/anomaly lab/i)).first().click();
await page.waitForTimeout(900);
await shot("anomaly-forward.png");

// The backward scenario is where RGA breaks and Fugue does not, so it is the
// frame worth putting in the README.
const backward = page.getByRole("button", { name: /backward interleaving/i });
if (await backward.count()) {
  await backward.first().click();
  await page.waitForTimeout(900);
  await shot("anomaly-lab.png");
} else {
  console.warn("backward scenario button not found");
}

// --- Chaos, and the recording -------------------------------------------
await page.getByRole("tab", { name: /chaos/i }).or(page.getByText(/^chaos$/i)).first().click();
await page.waitForTimeout(700);

const scripted = page.getByRole("button", { name: /go offline, type, come back/i });
if (await scripted.count()) {
  await scripted.first().click();
  // 2.6s is the peak of phase 2: Ada is cut off, both replicas are typing, and
  // her packets are visibly queueing with nowhere to go. Sampled empirically —
  // packet dots live about a second, so 5s landed in a dead gap between bursts
  // and produced an empty, meaningless panel.
  await page.waitForTimeout(2600);
  await shot("chaos.png");
  // Enough to record the heal and the convergence, and no more: trailing dead
  // air is most of what makes a demo GIF large.
  await page.waitForTimeout(6500);
} else {
  console.warn("scripted demo button not found");
  await shot("chaos.png");
  await page.waitForTimeout(2000);
}

await shutdown();

// --- webm -> gif ---------------------------------------------------------
const videos = (await readdir(TMP)).filter((f) => f.endsWith(".webm"));
if (videos.length === 0) {
  console.warn("no video recorded");
  process.exit(0);
}
const webm = join(TMP, videos[0]);

if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) {
  console.warn(`ffmpeg not found; raw recording left at ${webm}`);
  process.exit(0);
}

const palette = join(TMP, "palette.png");
// Crop the empty lower third before scaling: the app shell fills a 900px
// viewport but no panel reaches past ~580, and dead pixels are most of what
// makes a demo GIF large.
const filters = "crop=1440:580:0:0,fps=10,scale=900:-1:flags=lanczos";
const quiet = ["-hide_banner", "-loglevel", "error"];
spawnSync(
  "ffmpeg",
  [...quiet, "-y", "-i", webm, "-vf", `${filters},palettegen=stats_mode=diff`, "-frames:v", "1", "-update", "1", palette],
  { stdio: "inherit" },
);
spawnSync(
  "ffmpeg",
  [...quiet, "-y", "-i", webm, "-i", palette, "-lavfi", `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, join(ASSETS, "demo.gif")],
  { stdio: "inherit" },
);
console.log(`wrote ${join(ASSETS, "demo.gif")}`);
