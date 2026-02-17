import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const DEFAULT_URL = 'https://www.axs.com/events/1195982/wwe-friday-night-smackdown-tickets';

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const val = process.argv[idx + 1];
  if (!val || val.startsWith('--')) return null;
  return val;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function readJson(jsonPath, fallback) {
  try {
    const raw = await fs.readFile(jsonPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(jsonPath, data) {
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(jsonPath, JSON.stringify(data, null, 2), 'utf8');
}

function pickNextUserAgent({ userAgents, used }) {
  const unused = userAgents.filter((ua) => !used.includes(ua));
  if (unused.length === 0) {
    return { ua: userAgents[Math.floor(Math.random() * userAgents.length)], resetUsed: true };
  }
  const ua = unused[Math.floor(Math.random() * unused.length)];
  return { ua, resetUsed: false };
}

async function main() {
  const url = getArgValue('--url') ?? DEFAULT_URL;
  const headless = hasFlag('--headless');

  const uaFile = getArgValue('--ua-file') ?? path.join(projectRoot, 'uas.json');
  const explicitUa = getArgValue('--ua');

  const artifactsDir = path.join(projectRoot, 'artifacts');
  const statePath = path.join(projectRoot, '.state', 'used_uas.json');

  let userAgent = explicitUa;

  if (!userAgent) {
    const userAgents = await readJson(uaFile, []);
    if (!Array.isArray(userAgents) || userAgents.length === 0) {
      throw new Error(
        `No user agents found. Provide --ua "..." or create a JSON array at: ${uaFile}`
      );
    }

    const used = await readJson(statePath, []);
    const { ua, resetUsed } = pickNextUserAgent({ userAgents, used: Array.isArray(used) ? used : [] });
    userAgent = ua;

    const nextUsed = resetUsed ? [ua] : [...(Array.isArray(used) ? used : []), ua];
    await writeJson(statePath, nextUsed);
  }

  const browser = await puppeteer.launch({
    headless,
    args: ['--no-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(userAgent);

    // Basic viewport settings for testing (not fingerprint spoofing).
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

    console.log(`Opening: ${url}`);
    console.log(`User-Agent: ${userAgent}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);

    await fs.mkdir(artifactsDir, { recursive: true });
    const screenshotPath = path.join(artifactsDir, 'axs.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log(`Saved screenshot: ${screenshotPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
