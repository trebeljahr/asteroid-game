// Captures the README / social-preview screenshots of Asteroids from a local
// dev setup. Headless Chromium plays the real game with keyboard input; two
// browser contexts meet in a 1v1 duel through the real game server.
//
// Run the game server and the client (no database or Redis needed):
//   (cd server && PORT=<api port> node --import tsx ./src/server.ts)
//   (cd client && API_PORT=<api port> npx vite --port <web port> --strictPort --host 127.0.0.1)
//   BASE_URL=http://127.0.0.1:<web port> node scripts/marketing/capture-screenshots.mjs
//
// The client's Math.random is seeded (SEED, default 7), so a singleplayer run
// starts from the same asteroid field each time. Frame timing still varies a
// little. --burst=<n> writes n frames per scene to BURST_DIR to pick from.
// --gif also records a short singleplayer flight to flight.gif (needs ffmpeg).
//
// Playwright is not a dependency of this repo. The script loads it from the
// repo, from PLAYWRIGHT_MODULE (a package folder), or from the global npm root.
// CHROMIUM_PATH may name a Chromium binary. Chromium runs muted.
//
// Output: docs/marketing/screenshots/*.jpg (desktop at 2x), flight.gif.

import { execFileSync, execSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = process.env.SCREENSHOT_OUT ?? join(root, "docs/marketing/screenshots");
const burstArg = process.argv.find((arg) => arg.startsWith("--burst="));
const burst = burstArg ? Number(burstArg.split("=")[1]) : 0;
const burstDir = process.env.BURST_DIR ?? join(outDir, "burst");
const seed = Number(process.env.SEED ?? 7);
const jpeg = { type: "jpeg", quality: 82 };
const recordGif = process.argv.includes("--gif");
const baseUrl = (process.env.BASE_URL ?? "").replace(/\/$/, "");
if (!baseUrl) {
  console.error("Set BASE_URL to the running client, e.g. http://127.0.0.1:64546");
  process.exit(1);
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  try {
    return require("playwright");
  } catch {
    const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    return createRequire(join(globalRoot, "noop.js"))("playwright");
  }
}

const { chromium } = loadPlaywright();

// mulberry32, installed before any game code runs.
function seededRandom(start) {
  let state = start >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function openGame(browser, options) {
  const context = await browser.newContext({ colorScheme: "dark", ...options });
  await context.addInitScript(seededRandom, seed);
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  return { context, page };
}

// The named shot first, then the burst frames that follow it.
async function shoot(page, name, { frames = burst, gap = 200 } = {}) {
  await page.screenshot({ ...jpeg, path: join(outDir, `${name}.jpg`) });
  if (frames > 0) {
    await mkdir(burstDir, { recursive: true });
    for (let i = 1; i <= frames; i++) {
      await page.waitForTimeout(gap);
      await page.screenshot({
        ...jpeg,
        path: join(burstDir, `${name}-${String(i).padStart(2, "0")}.jpg`),
      });
    }
  }
}

// Hold keys for a while: [codes to hold, milliseconds].
async function fly(page, steps) {
  for (const [codes, ms] of steps) {
    for (const code of codes) await page.keyboard.down(code);
    await page.waitForTimeout(ms);
    for (const code of codes) await page.keyboard.up(code);
  }
}

// 3.6 s of thrust from a recorded singleplayer run, 560 px wide at 15 fps.
async function flightGif(browser) {
  const videoDir = await mkdtemp(join(tmpdir(), "asteroids-flight-"));
  const size = { width: 960, height: 600 };
  const context = await browser.newContext({
    viewport: size,
    recordVideo: { dir: videoDir, size },
  });
  const recordingStart = Date.now();
  await context.addInitScript(seededRandom, seed);
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "SINGLEPLAYER MODE" }).click();
  await page.waitForTimeout(1500);
  await fly(page, [[["KeyA"], 1000]]);
  const thrustAt = (Date.now() - recordingStart) / 1000;
  await fly(page, [
    [["KeyW"], 2200],
    [["KeyW", "KeyD"], 350],
    [["KeyW"], 1500],
  ]);
  await context.close();
  const video = join(
    videoDir,
    (await readdir(videoDir)).find((name) => name.endsWith(".webm")),
  );
  const palette =
    "fps=15,scale=560:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];" +
    "[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle";
  execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-ss",
    String(Math.max(0, thrustAt + 0.3)),
    "-t",
    "3.6",
    "-i",
    video,
    "-vf",
    palette,
    join(outDir, "flight.gif"),
  ]);
  await rm(videoDir, { recursive: true, force: true });
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--mute-audio", "--use-angle=metal"],
  });
  const desktop = { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 };

  // Main menu: the six ships and the three modes.
  const menu = await openGame(browser, desktop);
  await menu.page.getByRole("button", { name: "Comet Lance" }).click();
  await menu.page.waitForTimeout(500);
  await shoot(menu.page, "menu-ships", { frames: 0 });
  await menu.context.close();

  // Singleplayer run: turn toward the arrow that points at the first goal,
  // then thrust at it. Without picked-up ammo the ship does not fire here.
  const solo = await openGame(browser, desktop);
  await solo.page.getByRole("button", { name: "SINGLEPLAYER MODE" }).click();
  await solo.page.waitForTimeout(1500);
  await fly(solo.page, [[["KeyA"], 1000]]);
  await solo.page.keyboard.down("KeyW");
  await solo.page.waitForTimeout(1050);
  await shoot(solo.page, "singleplayer");
  await solo.page.keyboard.up("KeyW");
  await solo.context.close();

  // 1v1 duel: two players queue, the server pairs them.
  const duelists = [];
  for (const ship of ["Ember Needle", "Aurora Sprint"]) {
    const player = await openGame(browser, desktop);
    await player.page.getByRole("button", { name: ship }).click();
    await player.page.getByRole("button", { name: "MULTIPLAYER DUEL" }).click();
    duelists.push(player);
  }
  await duelists[0].page.waitForTimeout(6500);
  await Promise.all(
    duelists.map((player, index) =>
      fly(player.page, [
        [["KeyW"], 600],
        [[index === 0 ? "KeyA" : "KeyD"], 250],
        [["KeyW", "Space"], 900],
        [["Space"], 400],
      ]),
    ),
  );
  await duelists[0].page.keyboard.down("Space");
  await shoot(duelists[0].page, "duel");
  await duelists[0].page.keyboard.up("Space");
  for (const player of duelists) await player.context.close();

  // Phone in landscape with the touch controls.
  const phone = await openGame(browser, {
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  await phone.page.getByRole("button", { name: "SINGLEPLAYER MODE" }).click();
  await phone.page.waitForTimeout(1500);
  await fly(phone.page, [[["KeyA"], 1000]]);
  await phone.page.keyboard.down("KeyW");
  await phone.page.waitForTimeout(700);
  await shoot(phone.page, "phone-landscape");
  await phone.page.keyboard.up("KeyW");
  await phone.context.close();

  if (recordGif) await flightGif(browser);

  await browser.close();
  console.log(`Wrote screenshots to ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
