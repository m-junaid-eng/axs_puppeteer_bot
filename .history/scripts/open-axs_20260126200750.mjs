import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const DEFAULT_URL = 'https://www.axs.com/events/1195982/wwe-friday-night-smackdown-tickets';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function getFingerprintSignals(page) {
  return await page.evaluate(async () => {
    const fingerprint = {
      collectedAt: new Date().toISOString(),
      location: {
        href: location.href
      },
      navigator: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        languages: navigator.languages,
        language: navigator.language,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        maxTouchPoints: navigator.maxTouchPoints,
        webdriver: navigator.webdriver,
        cookieEnabled: navigator.cookieEnabled
      },
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth
      },
      window: {
        devicePixelRatio: window.devicePixelRatio,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight
      },
      timezone: {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offsetMinutes: new Date().getTimezoneOffset()
      }
    };

    // Canvas signal (not spoofed): draw a tiny canvas and hash its data URL.
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 240;
      canvas.height = 60;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.textBaseline = 'top';
        ctx.font = '16px Arial';
        ctx.fillStyle = '#f60';
        ctx.fillRect(0, 0, 100, 40);
        ctx.fillStyle = '#069';
        ctx.fillText('fingerprint test ✨', 2, 2);
        ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
        ctx.fillText('fingerprint test ✨', 4, 18);
        const dataUrl = canvas.toDataURL();

        // Simple hash (djb2) for compactness.
        let hash = 5381;
        for (let i = 0; i < dataUrl.length; i++) hash = (hash * 33) ^ dataUrl.charCodeAt(i);
        fingerprint.canvas = { dataUrlLength: dataUrl.length, djb2: (hash >>> 0).toString(16) };
      }
    } catch (e) {
      fingerprint.canvas = { error: String(e) };
    }

    // WebGL vendor/renderer (not spoofed).
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        const vendor = debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
          : gl.getParameter(gl.VENDOR);
        const renderer = debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER);
        fingerprint.webgl = { vendor, renderer };
      }
    } catch (e) {
      fingerprint.webgl = { error: String(e) };
    }

    // Media devices count (permissions may limit details).
    try {
      if (navigator.mediaDevices?.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const counts = devices.reduce(
          (acc, d) => {
            acc[d.kind] = (acc[d.kind] || 0) + 1;
            return acc;
          },
          /** @type {Record<string, number>} */ ({})
        );
        fingerprint.mediaDevices = { counts };
      }
    } catch (e) {
      fingerprint.mediaDevices = { error: String(e) };
    }

    return fingerprint;
  });
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
  const freshProfile = hasFlag('--fresh-profile');
  const dumpFingerprint = !hasFlag('--no-fingerprint');

  const uaFile = getArgValue('--ua-file') ?? path.join(projectRoot, 'uas.json');
  const explicitUa = getArgValue('--ua');

  const artifactsDir = path.join(projectRoot, 'artifacts');
  const statePath = path.join(projectRoot, '.state', 'used_uas.json');
  const profilesDir = path.join(projectRoot, '.state', 'profiles');

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

  const userDataDir = freshProfile ? path.join(profilesDir, String(Date.now())) : undefined;

  const browser = await puppeteer.launch({
    headless,
    userDataDir,
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
    await sleep(3000);

    if (dumpFingerprint) {
      const fingerprint = await getFingerprintSignals(page);
      await fs.mkdir(artifactsDir, { recursive: true });
      const fpPath = path.join(artifactsDir, 'fingerprint.json');
      await fs.writeFile(fpPath, JSON.stringify(fingerprint, null, 2), 'utf8');
      console.log(`Saved fingerprint signals: ${fpPath}`);
    }

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
