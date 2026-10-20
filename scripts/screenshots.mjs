// Regenerates the images in docs/screenshots/ from a running dashboard.
//
// Requirements:
//   - the proxy, the mock and the dashboard are running (scripts/demo.sh does this)
//   - puppeteer-core is installed and a Chrome or Edge binary is available
//
// Usage:
//   npm i -D puppeteer-core
//   node scripts/screenshots.mjs
//
// The script screenshots the three sections of the dashboard page, so the images
// always match the real UI instead of a mock-up.

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer-core";

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "http://127.0.0.1:3000";
const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const executablePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!executablePath) {
  console.error("No Chrome or Edge binary found. Set CHROME_PATH.");
  process.exit(1);
}

const SHOTS = [
  { file: "cost-chart.png", heading: "View 1 — cost over time" },
  { file: "request-feed.png", heading: "View 2 — live request feed" },
  { file: "alerts.png", heading: "View 3 — alerts" },
];

await mkdir(OUTPUT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await page.goto(DASHBOARD_URL, { waitUntil: "networkidle0" });
  // Let the first poll land so the views are filled.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  for (const shot of SHOTS) {
    const handle = await page.evaluateHandle((heading) => {
      const sections = Array.from(document.querySelectorAll("section"));
      const match = sections.find((section) =>
        section.querySelector("h2")?.textContent?.includes(heading),
      );
      return match ?? null;
    }, shot.heading);

    const element = handle.asElement();
    if (!element) {
      console.error(`Could not find the section "${shot.heading}"`);
      continue;
    }

    await element.screenshot({ path: join(OUTPUT_DIR, shot.file) });
    console.log(`wrote ${shot.file}`);
  }

  await page.screenshot({ path: join(OUTPUT_DIR, "dashboard.png"), fullPage: true });
  console.log("wrote dashboard.png");
} finally {
  await browser.close();
}
