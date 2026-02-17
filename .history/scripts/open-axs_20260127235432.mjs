import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

import * as XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const DEFAULT_URL = 'https://www.axs.com/teams/113914/wwe-tickets';

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(value) {
	return String(value)
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);
}

function safeFilename(value) {
	const s = slugify(value);
	return s.length ? s : 'page';
}

async function saveHtml({ page, filePath }) {
	const html = await page.content();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, html, 'utf8');
}

async function promptEnter(message, { timeoutMs = 0, skipIfNoTty = false } = {}) {
	if (skipIfNoTty && !input.isTTY) {
		console.log('(No interactive stdin detected; continuing without waiting.)');
		return;
	}

	const rl = readline.createInterface({ input, output });
	try {
		if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), timeoutMs);
			try {
				await rl.question(message, { signal: ac.signal });
			} catch (e) {
				const msg = String(e?.name || e?.message || e);
				// Timeout (AbortError) -> continue.
				if (!msg.toLowerCase().includes('abort')) throw e;
				console.log('(No input; continuing.)');
			} finally {
				clearTimeout(t);
			}
			return;
		}

		await rl.question(message);
	} finally {
		rl.close();
	}
}

function normalizeText(s) {
	return String(s ?? '').replace(/\s+/g, ' ').trim();
}

async function isLikelyCaptchaPage(page) {
	try {
		const url = page.url().toLowerCase();
		if (
			url.includes('captcha') ||
			url.includes('challenge') ||
			url.includes('arkoselabs') ||
			url.includes('cdn-cgi')
		) {
			return true;
		}

		const title = (await page.title()).toLowerCase();
		if (
			title.includes('captcha') ||
			title.includes('challenge') ||
			title.includes('just a moment') ||
			title.includes('checking your browser')
		) {
			return true;
		}

		const hasCaptchaHints = await page.evaluate(() => {
			const text = (document.body?.innerText || '').toLowerCase();
			if (
				text.includes('captcha') ||
				text.includes('verify you are') ||
				text.includes('are you human') ||
				text.includes('just a moment') ||
				text.includes('checking your browser') ||
				text.includes('cloudflare')
			) {
				return true;
			}

			// Cloudflare Turnstile / challenge markers.
			if (
				document.querySelector('input[name="cf-turnstile-response"]') ||
				document.querySelector('[id^="cf-chl-"]') ||
				document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]') ||
				document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')
			) {
				return true;
			}

			// Some challenge pages define this global.
			// eslint-disable-next-line no-undef
			if (typeof window !== 'undefined' && (window._cf_chl_opt || window.__CF$cv$params)) return true;

			const iframes = Array.from(document.querySelectorAll('iframe'));
			return iframes.some((f) => (f.src || '').toLowerCase().includes('captcha'));
		});
		return hasCaptchaHints;
	} catch {
		return false;
	}
}

async function waitForManualCaptchaSolve(page, { interactive }) {
	if (!interactive) return;

	// Some challenges appear a moment AFTER DOMContentLoaded.
	let challengeDetected = false;
	for (let i = 0; i < 60; i++) {
		if (await isLikelyCaptchaPage(page)) {
			challengeDetected = true;
			break;
		}
		await sleep(500);
	}

	if (!challengeDetected) return;

	console.log('Cloudflare/CAPTCHA challenge detected.');
	console.log('Solve it in the opened browser tab. This script will wait until the real event page loads.');

	try {
		await page.bringToFront();
	} catch {
		// ignore
	}

	// Auto-wait: no Enter needed while solving.
	const started = Date.now();
	const timeoutMs = 10 * 60_000; // 10 minutes
	let lastLog = 0;
	while (Date.now() - started < timeoutMs) {
		if (page.isClosed()) return;
		if (await isLikelyCaptchaPage(page)) {
			if (Date.now() - lastLog > 15_000) {
				console.log('Waiting for CAPTCHA to clear...');
				lastLog = Date.now();
			}
			await sleep(1000);
			continue;
		}

		// Not a challenge page now; wait for event markers.
		const ok = await waitForLikelyEventPage(page, { timeoutMs: 5000 });
		if (ok) return;
		await sleep(500);
	}

	console.log('Timed out waiting for CAPTCHA to clear / event page to load.');
}

async function waitForManualChallengeClear(page, { interactive, timeoutMs = 10 * 60_000 } = {}) {
	// Generic variant for non-event pages (e.g., ticketing/checkout) where we only
	// need the Cloudflare/challenge page to clear.
	if (!interactive) return;

	// Some challenges appear a moment AFTER navigation.
	let challengeDetected = false;
	for (let i = 0; i < 60; i++) {
		if (await isLikelyCaptchaPage(page)) {
			challengeDetected = true;
			break;
		}
		await sleep(500);
	}

	if (!challengeDetected) return true;

	console.log('Cloudflare/CAPTCHA challenge detected (tickets page).');
	console.log('Solve it in the opened browser tab. This script will continue once the challenge clears.');

	try {
		await page.bringToFront();
	} catch {
		// ignore
	}

	const started = Date.now();
	let lastLog = 0;
	let clearedStreak = 0;
	while (Date.now() - started < timeoutMs) {
		if (page.isClosed()) return;
		const isCaptcha = await isLikelyCaptchaPage(page);
		if (isCaptcha) {
			clearedStreak = 0;
			if (Date.now() - lastLog > 15_000) {
				console.log('Waiting for CAPTCHA to clear...');
				lastLog = Date.now();
			}
			await sleep(1000);
			continue;
		}

		// Require it to stay cleared (helps with redirect -> re-challenge loops).
		clearedStreak++;
		if (clearedStreak < 30) {
			await sleep(500);
			continue;
		}

		return true;
	}

	console.log('Timed out waiting for CAPTCHA to clear.');
	return false;
}

async function waitForEventPageAfterSolve(page, { timeoutMs }) {
	const started = Date.now();
	let clearedStreak = 0;

	while (Date.now() - started < timeoutMs) {
		const isCaptcha = await isLikelyCaptchaPage(page);
		if (isCaptcha) {
			clearedStreak = 0;
			await sleep(500);
			continue;
		}

		clearedStreak++;
		// Require it to stay cleared for a short period (handles redirect back to challenge).
		if (clearedStreak < 6) {
			await sleep(500);
			continue;
		}

		// Now wait for likely event markers.
		const ok = await waitForLikelyEventPage(page, { timeoutMs: 20_000 });
		if (ok) return true;
		await sleep(500);
	}

	return false;
}

async function extractEventDetails(page, { fallbackUrl, eventId }) {
	const result = {
		eventId,
		url: fallbackUrl,
		name: '',
		startDate: '',
		venue: '',
		address: '',
		city: '',
		region: '',
		country: '',
		description: ''
	};

	const data = await page.evaluate(() => {
		const out = {
			title: document.title,
			canonical: document.querySelector('link[rel="canonical"]')?.href ?? '',
			ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? '',
			ogDescription: document.querySelector('meta[property="og:description"]')?.content ?? '',
			jsonLd: []
		};

		const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
		for (const s of scripts) {
			const txt = s.textContent;
			if (!txt) continue;
			try {
				out.jsonLd.push(JSON.parse(txt));
			} catch {
				// ignore
			}
		}

		return out;
	});

	// Find an Event object in JSON-LD.
	const jsonLdNodes = [];
	const pushNode = (node) => {
		if (!node) return;
		if (Array.isArray(node)) {
			for (const n of node) pushNode(n);
			return;
		}
		if (typeof node !== 'object') return;
		jsonLdNodes.push(node);
		if (node['@graph']) pushNode(node['@graph']);
	};
	for (const entry of data.jsonLd) pushNode(entry);

	const isEventType = (t) => {
		if (!t) return false;
		if (Array.isArray(t)) return t.some((x) => String(x).toLowerCase().includes('event'));
		return String(t).toLowerCase().includes('event');
	};
	const eventNode = jsonLdNodes.find((n) => isEventType(n['@type'])) ?? null;

	const pageUrl = data.canonical || fallbackUrl;
	result.url = pageUrl;

	if (eventNode) {
		result.name = normalizeText(eventNode.name || data.ogTitle || data.title);
		result.startDate = normalizeText(eventNode.startDate || '');
		result.description = normalizeText(eventNode.description || data.ogDescription || '');

		const loc = eventNode.location;
		const place = Array.isArray(loc) ? loc[0] : loc;
		if (place && typeof place === 'object') {
			result.venue = normalizeText(place.name || '');
			const addr = place.address;
			if (addr && typeof addr === 'object') {
				result.address = normalizeText(addr.streetAddress || '');
				result.city = normalizeText(addr.addressLocality || '');
				result.region = normalizeText(addr.addressRegion || '');
				result.country = normalizeText(addr.addressCountry || '');
			}
		}
	} else {
		result.name = normalizeText(data.ogTitle || data.title);
		result.description = normalizeText(data.ogDescription || '');
	}

	return result;
}

async function writeXlsx({ rows, filePath }) {
	const wb = XLSX.utils.book_new();
	const ws = XLSX.utils.json_to_sheet(rows);
	XLSX.utils.book_append_sheet(wb, ws, 'events');
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	XLSX.writeFile(wb, filePath);
}

async function configurePageForRun(page, { userAgent, noUaOverride } = {}) {
	// Keep this minimal and consistent across tabs/pages.
	await page.setExtraHTTPHeaders({
		'accept-language': 'en-US,en;q=0.9'
	});
	if (userAgent && !noUaOverride) {
		await page.setUserAgent(userAgent);
	}
	await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
}

async function findFirstLinkByText(page, needle) {
	const lowerNeedle = String(needle).toLowerCase();
	const href = await page.$$eval(
		'a[href]',
		(as, lowerNeedleIn) => {
			const match = as.find((a) => (a.textContent || '').trim().toLowerCase().includes(lowerNeedleIn));
			return match ? match.href : null;
		},
		lowerNeedle
	);
	return href;
}

async function findGetTicketsHref(page) {
	// The AXS EDP uses a LinkButton for the primary CTA.
	return await page.evaluate(() => {
		const anchors = Array.from(document.querySelectorAll('a[href]'));
		const pick = anchors.find((a) => {
			const text = (a.textContent || '').trim().toLowerCase();
			const aria = (a.getAttribute('aria-label') || '').trim().toLowerCase();
			if (!(text.includes('get tickets') || aria.includes('get tickets'))) return false;
			return true;
		});
		return pick ? pick.href : null;
	});
}

async function collectSeeEventLinks(page) {
	const links = await page.$$eval('a[href]', (as) => {
		const out = [];
		for (const a of as) {
			const text = (a.textContent || '').trim();
			const aria = (a.getAttribute('aria-label') || '').trim();
			const combined = `${text} ${aria}`.toLowerCase();
			if (combined.includes('see event')) {
				const label = aria || text || a.href;
				out.push({ href: a.href, label });
			}
		}
		const seen = new Set();
		return out.filter((x) => {
			if (seen.has(x.href)) return false;
			seen.add(x.href);
			return true;
		});
	});
	return links;
}

async function collectSeeEventLinksInAllEventsSection(page) {
	return await page.evaluate(() => {
		const headings = Array.from(document.querySelectorAll('h2[data-testid="EventsTitle"]'));
		const allEventsHeading = headings.find((h) => (h.textContent || '').trim().toLowerCase() === 'all events');
		if (!allEventsHeading) return [];

		const root = allEventsHeading.parentElement ?? document.body;
		const anchors = Array.from(root.querySelectorAll('a[href]'));
		const out = [];
		for (const a of anchors) {
			const text = (a.textContent || '').trim();
			const aria = (a.getAttribute('aria-label') || '').trim();
			const combined = `${text} ${aria}`.toLowerCase();
			if (combined.includes('see event')) {
				const label = aria || text || a.href;
				out.push({ href: a.href, label });
			}
		}

		const seen = new Set();
		return out.filter((x) => {
			if (seen.has(x.href)) return false;
			seen.add(x.href);
			return true;
		});
	});
}

async function collectEventDetailLinksByPattern(page) {
	// Fallback when "See Event" text isn’t present.
	return await page.$$eval('a[href]', (as) => {
		const out = [];
		const re = /\/events\/(\d+)/;
		for (const a of as) {
			const href = a.href;
			if (!href) continue;
			if (!re.test(href)) continue;
			out.push({ href, label: (a.textContent || '').trim() || href });
		}
		const seen = new Set();
		return out.filter((x) => {
			if (seen.has(x.href)) return false;
			seen.add(x.href);
			return true;
		});
	});
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

async function waitForLikelyEventPage(page, { timeoutMs }) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (await isLikelyCaptchaPage(page)) return false;

		const hasEventHints = await page.evaluate(() => {
			const title = (document.title || '').toLowerCase();
			if (title.includes('just a moment') || title.includes('checking your browser')) return false;

			const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
			for (const s of scripts) {
				const txt = s.textContent || '';
				if (!txt) continue;
				if (txt.includes('"@type"') && txt.toLowerCase().includes('event')) return true;
			}

			const og = document.querySelector('meta[property="og:title"]')?.content || '';
			return Boolean(og && og.trim().length > 0);
		});

		if (hasEventHints) return true;
		await sleep(500);
	}
	return false;
}

async function waitForAllEventsArea(page, { timeoutMs }) {
	const started = Date.now();
	let scrolls = 0;

	while (Date.now() - started < timeoutMs) {
		if (page.isClosed()) return false;

		let found = false;
		try {
			found = await page.evaluate(() => {
				const hasAllEventsHeading = Array.from(
					document.querySelectorAll('h2[data-testid="EventsTitle"]')
				).some((h) => (h.textContent || '').trim().toLowerCase() === 'all events');

				const hasAllEventsLink = Array.from(document.querySelectorAll('a[href]')).some((a) =>
					(a.textContent || '').trim().toLowerCase().includes('all events')
				);

				const hasSeeEvent = Array.from(document.querySelectorAll('a[href]')).some((a) => {
					const text = (a.textContent || '').trim();
					const aria = (a.getAttribute('aria-label') || '').trim();
					return `${text} ${aria}`.toLowerCase().includes('see event');
				});

				const hasEventLinks = Array.from(document.querySelectorAll('a[href]')).some((a) =>
					/\/events\/\d+/.test(a.href)
				);

				return hasAllEventsHeading || hasAllEventsLink || hasSeeEvent || hasEventLinks;
			});
		} catch (err) {
			const msg = String(err?.message || err);
			if (msg.toLowerCase().includes('execution context was destroyed')) {
				await sleep(500);
				continue;
			}
			throw err;
		}

		if (found) return true;

		if (scrolls < 8) {
			try {
				await page.evaluate(() => window.scrollBy(0, Math.max(400, window.innerHeight * 0.8)));
			} catch {
				// ignore
			}
			scrolls++;
		}

		await sleep(1000);
	}

	return false;
}

async function waitForAllEventsHeading(page, { timeoutMs }) {
	const started = Date.now();
	let scrolls = 0;

	while (Date.now() - started < timeoutMs) {
		if (page.isClosed()) return false;
		if (await isLikelyCaptchaPage(page)) return false;

		let found = false;
		try {
			found = await page.evaluate(() => {
				return Array.from(document.querySelectorAll('h2[data-testid="EventsTitle"]')).some(
					(h) => (h.textContent || '').trim().toLowerCase() === 'all events'
				);
			});
		} catch (err) {
			const msg = String(err?.message || err);
			if (msg.toLowerCase().includes('execution context was destroyed')) {
				await sleep(500);
				continue;
			}
			throw err;
		}

		if (found) return true;

		if (scrolls < 14) {
			try {
				await page.evaluate(() => window.scrollBy(0, Math.max(600, window.innerHeight * 0.85)));
			} catch {
				// ignore
			}
			scrolls++;
		}

		await sleep(800);
	}

	return false;
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

				let hash = 5381;
				for (let i = 0; i < dataUrl.length; i++) hash = (hash * 33) ^ dataUrl.charCodeAt(i);
				fingerprint.canvas = { dataUrlLength: dataUrl.length, djb2: (hash >>> 0).toString(16) };
			}
		} catch (e) {
			fingerprint.canvas = { error: String(e) };
		}

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

async function appendText(filePath, line) {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.appendFile(filePath, line, 'utf8');
}

function pickNextUserAgent({ userAgents, used }) {
	const unused = userAgents.filter((ua) => !used.includes(ua));
	if (unused.length === 0) {
		return { ua: userAgents[Math.floor(Math.random() * userAgents.length)], resetUsed: true };
	}
	const ua = unused[Math.floor(Math.random() * unused.length)];
	return { ua, resetUsed: false };
}

async function fileExists(p) {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function resolveSystemChromeExecutable({ explicitPath }) {
	if (explicitPath) {
		const abs = path.isAbsolute(explicitPath) ? explicitPath : path.join(projectRoot, explicitPath);
		if (await fileExists(abs)) return abs;
		throw new Error(`Chrome executable not found at: ${abs}`);
	}

	if (process.platform !== 'win32') return null;

	const candidates = [
		'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
		path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
	].filter(Boolean);

	for (const p of candidates) {
		if (await fileExists(p)) return p;
	}
	return null;
}

async function main() {
	const url = getArgValue('--url') ?? DEFAULT_URL;
	const interactive = hasFlag('--interactive');
	const headlessRequested = hasFlag('--headless');
	const headless = interactive ? false : headlessRequested;

	const freshProfile = hasFlag('--fresh-profile');
	const profileArg = getArgValue('--profile');
	const rotateUa = hasFlag('--rotate-ua');
	const noUaOverride = hasFlag('--no-ua-override');
	const noSandbox = hasFlag('--no-sandbox');
	const stepMode = hasFlag('--step');
	const keepOpen = hasFlag('--keep-open');
	const useSystemChrome = hasFlag('--use-system-chrome');
	const chromePath = getArgValue('--chrome-path');

	const dumpFingerprint = !hasFlag('--no-fingerprint');
	const saveMainHtml = !hasFlag('--no-save-html');
	const followAllEvents = hasFlag('--all-events');
	const exportXlsx = followAllEvents && !hasFlag('--no-xlsx');

	const xlsxPath = getArgValue('--xlsx-path') ?? path.join(projectRoot, 'artifacts', 'events.xlsx');
	const maxEventsRaw = getArgValue('--max-events');
	const maxEvents = maxEventsRaw ? Number(maxEventsRaw) : 10;
	const delayMsRaw = getArgValue('--delay-ms');
	const delayMsProvided = delayMsRaw !== null;
	const delayMs = delayMsRaw ? Number(delayMsRaw) : interactive ? 8000 : 1500;

	const postSolveWaitMsRaw = getArgValue('--post-solve-wait-ms');
	const postSolveWaitMs = postSolveWaitMsRaw ? Number(postSolveWaitMsRaw) : interactive ? 6000 : 0;

	const uaFile = getArgValue('--ua-file') ?? path.join(projectRoot, 'uas.json');
	const explicitUa = getArgValue('--ua');

	const artifactsDir = path.join(projectRoot, 'artifacts');
	const statePath = path.join(projectRoot, '.state', 'used_uas.json');
	const profilesDir = path.join(projectRoot, '.state', 'profiles');

	// UA strategy: in interactive mode, do not override UA unless explicitly requested.
	let userAgent = explicitUa;
	if (!userAgent && (rotateUa || (!interactive && !noUaOverride))) {
		const userAgents = await readJson(uaFile, []);
		if (!Array.isArray(userAgents) || userAgents.length === 0) {
			throw new Error(`No user agents found. Provide --ua "..." or create a JSON array at: ${uaFile}`);
		}
		const used = await readJson(statePath, []);
		const { ua, resetUsed } = pickNextUserAgent({ userAgents, used: Array.isArray(used) ? used : [] });
		userAgent = ua;
		const nextUsed = resetUsed ? [ua] : [...(Array.isArray(used) ? used : []), ua];
		await writeJson(statePath, nextUsed);
	}

	// Profile strategy: interactive defaults to a persistent profile.
	let userDataDir;
	if (freshProfile) {
		userDataDir = path.join(profilesDir, String(Date.now()));
	} else if (profileArg) {
		userDataDir = path.isAbsolute(profileArg) ? profileArg : path.join(projectRoot, profileArg);
	} else if (interactive) {
		userDataDir = path.join(profilesDir, 'interactive');
	}

	const executablePath = useSystemChrome || chromePath
		? await resolveSystemChromeExecutable({ explicitPath: chromePath })
		: null;

	if ((useSystemChrome || chromePath) && !executablePath) {
		throw new Error(
			'Could not auto-detect Chrome. Install Google Chrome or pass --chrome-path "C:\\path\\to\\chrome.exe".'
		);
	}

	const browser = await puppeteer.launch({
  headless: false,                 // always false for Cloudflare
  userDataDir,
  executablePath: executablePath ?? undefined,
  args: [
    ...(noSandbox ? ['--no-sandbox'] : []),
    '--disable-blink-features=AutomationControlled',
    '--start-maximized'
  ],
  defaultViewport: null
});


	try {
		const page = await browser.newPage();
		await configurePageForRun(page, { userAgent, noUaOverride });

		console.log(`Opening: ${url}`);
		console.log(`User-Agent: ${userAgent ?? '(default browser UA)'}`);
		if (interactive && userDataDir) {
			console.log(`Using profile: ${userDataDir}`);
		}
		if (executablePath) {
			console.log(`Using Chrome executable: ${executablePath}`);
		}

		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
		await sleep(3000);
		await waitForManualCaptchaSolve(page, { interactive });

		if (saveMainHtml) {
			const mainHtmlPath = path.join(artifactsDir, 'axs.html');
			await saveHtml({ page, filePath: mainHtmlPath });
			console.log(`Saved HTML: ${mainHtmlPath}`);
		}

		if (dumpFingerprint) {
			const fingerprint = await getFingerprintSignals(page);
			const runMeta = {
				url,
				headless,
				freshProfile,
				userDataDir: userDataDir ?? null,
				userAgentConfigured: userAgent
			};
			const payload = { meta: runMeta, fingerprint };

			await fs.mkdir(artifactsDir, { recursive: true });
			const fpLatestPath = path.join(artifactsDir, 'fingerprint.json');
			await fs.writeFile(fpLatestPath, JSON.stringify(payload, null, 2), 'utf8');

			const historyDir = path.join(artifactsDir, 'fingerprints');
			const stamp = new Date().toISOString().replace(/[:.]/g, '-');
			const fpHistoryPath = path.join(historyDir, `${stamp}.json`);
			await writeJson(fpHistoryPath, payload);

			const tsvPath = path.join(historyDir, 'fingerprints.tsv');
			const tsvLine = [
				payload.fingerprint.collectedAt,
				payload.meta.userAgentConfigured,
				payload.fingerprint.timezone?.timeZone ?? '',
				payload.fingerprint.webgl?.vendor ?? '',
				payload.fingerprint.webgl?.renderer ?? '',
				payload.fingerprint.canvas?.djb2 ?? ''
			]
				.map((v) => String(v).replace(/\t/g, ' '))
				.join('\t');
			await appendText(tsvPath, `${tsvLine}\n`);

			console.log(`Saved fingerprint signals: ${fpLatestPath}`);
			console.log(`Saved fingerprint history: ${fpHistoryPath}`);
			console.log(`Appended fingerprint log: ${tsvPath}`);
		}

		await fs.mkdir(artifactsDir, { recursive: true });
		const screenshotPath = path.join(artifactsDir, 'axs.png');
		await page.screenshot({ path: screenshotPath, fullPage: true });
		console.log(`Saved screenshot: ${screenshotPath}`);

		if (followAllEvents) {
			const scraped = [];
			const listingReferer = page.url();

			await waitForManualCaptchaSolve(page, { interactive });
			await waitForAllEventsHeading(page, { timeoutMs: interactive ? 60_000 : 25_000 });

			const hasAllEventsSection = await page.evaluate(() => {
				const h2s = Array.from(document.querySelectorAll('h2[data-testid="EventsTitle"]'));
				return h2s.some((h) => (h.textContent || '').trim().toLowerCase() === 'all events');
			});

			if (hasAllEventsSection) {
				await page.evaluate(() => {
					const h2s = Array.from(document.querySelectorAll('h2[data-testid="EventsTitle"]'));
					const h = h2s.find((x) => (x.textContent || '').trim().toLowerCase() === 'all events');
					h?.scrollIntoView({ block: 'start' });
				});
				await sleep(1500);
			} else {
				const allEventsHref = await findFirstLinkByText(page, 'All Events');
				if (allEventsHref) {
					console.log(`Navigating to All Events: ${allEventsHref}`);
					await page.goto(allEventsHref, { waitUntil: 'domcontentloaded', timeout: 60_000 });
					await sleep(2000);
					await waitForManualCaptchaSolve(page, { interactive });
					await waitForAllEventsHeading(page, { timeoutMs: interactive ? 60_000 : 25_000 });
				} else {
					console.log('No explicit "All Events" section/link found; searching for event links on the current page...');
				}
			}

			// If we got challenged on the listing page, pause here before saving/collecting.
			await waitForManualCaptchaSolve(page, { interactive });

			const listingHtmlPath = path.join(artifactsDir, 'all-events.html');
			if (saveMainHtml) {
				await saveHtml({ page, filePath: listingHtmlPath });
				console.log(`Saved HTML: ${listingHtmlPath}`);
			}

			let links = await collectSeeEventLinksInAllEventsSection(page);
			if (links.length === 0) links = await collectSeeEventLinks(page);
			if (links.length === 0) links = await collectEventDetailLinksByPattern(page);
			if (links.length === 0) {
				console.log('No event links found after waiting/scrolling.');
				if (interactive) {
					await promptEnter(
						'No event links found. If a challenge is showing, solve it and press Enter to close... ',
						{ skipIfNoTty: true }
					);
				}
				return;
			}

			const toVisit = links.slice(0, Number.isFinite(maxEvents) ? maxEvents : 10);
			console.log(`Found ${links.length} event links; visiting ${toVisit.length}.`);

			const eventsDir = path.join(artifactsDir, 'events');
			await fs.mkdir(eventsDir, { recursive: true });

			// Reuse the SAME tab/session for event + tickets navigation.
			// This tends to reduce repeated challenges vs opening fresh tabs.
			const eventPage = page;
			await configurePageForRun(eventPage, { userAgent, noUaOverride });

			for (let i = 0; i < toVisit.length; i++) {
					const { href, label } = toVisit[i];
					const idMatch = String(href).match(/\/events\/(\d+)/);
					const eventId = idMatch?.[1] ?? String(i + 1);

					console.log(`Event ${i + 1}/${toVisit.length}: ${href}`);
					if (interactive && stepMode) {
						await promptEnter('Press Enter to open the next event link (auto-continue in 30s)... ', {
							timeoutMs: 30_000,
							skipIfNoTty: true
						});
					}

					// Use a referer to match normal click navigation behavior.
					await eventPage.goto(href, {
						waitUntil: 'domcontentloaded',
						timeout: 60_000,
						referer: listingReferer
					});
					await sleep(1500);

					await waitForManualCaptchaSolve(eventPage, { interactive });
					if (interactive && postSolveWaitMs > 0) {
						await sleep(postSolveWaitMs);
					}
					if (interactive) {
						// Ensure we are truly past the challenge and on a stable event page.
						await waitForEventPageAfterSolve(eventPage, { timeoutMs: 120_000 });
						if (!(await isLikelyCaptchaPage(eventPage))) {
							await promptEnter('Event detail page reached. Press Enter to save and continue... ', {
								skipIfNoTty: true
							});
						}
					}

					if (await isLikelyCaptchaPage(eventPage)) {
						if (interactive) {
							console.log(
								`Still on CAPTCHA for event ${eventId}. The site is re-challenging this session; solve again and press Enter.`
							);
							await waitForManualCaptchaSolve(eventPage, { interactive });
							await waitForEventPageAfterSolve(eventPage, { timeoutMs: 120_000 });
						}
						if (await isLikelyCaptchaPage(eventPage)) {
							console.log(`Still on CAPTCHA for event ${eventId}; skipping scrape for this one.`);
							continue;
						}
					}

					const details = await extractEventDetails(eventPage, { fallbackUrl: href, eventId });
					scraped.push(details);

					const base = `${eventId}-${safeFilename(details.name || label)}`;
					const htmlPath = path.join(eventsDir, `${base}.html`);
					await saveHtml({ page: eventPage, filePath: htmlPath });

					const shotPath = path.join(eventsDir, `${base}.png`);
					await eventPage.screenshot({ path: shotPath, fullPage: true });
					console.log(`Saved: ${htmlPath}`);

					// Now go to the Get Tickets pricing page in the SAME tab.
					const ticketsHref = await findGetTicketsHref(eventPage);
					if (ticketsHref) {
						console.log(`Opening tickets page: ${ticketsHref}`);
						await eventPage.goto(ticketsHref, {
							waitUntil: 'domcontentloaded',
							timeout: 60_000,
							referer: href
						});
						await sleep(1500);
						const cleared1 = await waitForManualChallengeClear(eventPage, {
							interactive,
							timeoutMs: 180_000
						});
						if (!cleared1 || (await isLikelyCaptchaPage(eventPage))) {
							console.log(`Tickets page still blocked by CAPTCHA for event ${eventId}; skipping tickets capture.`);
							const blockedHtmlPath = path.join(eventsDir, `${base}-tickets-blocked.html`);
							await saveHtml({ page: eventPage, filePath: blockedHtmlPath });
							const blockedShotPath = path.join(eventsDir, `${base}-tickets-blocked.png`);
							await eventPage.screenshot({ path: blockedShotPath, fullPage: true });
							continue;
						}

						if (interactive) {
							await promptEnter(
								'Tickets page opened. If you need to click to load prices, do it now, then press Enter to save tickets HTML... ',
								{ skipIfNoTty: true }
							);
						}

						// If a re-challenge appears after interaction, wait it out again.
						const cleared2 = await waitForManualChallengeClear(eventPage, {
							interactive,
							timeoutMs: 180_000
						});
						if (!cleared2 || (await isLikelyCaptchaPage(eventPage))) {
							console.log(`Tickets page re-challenged for event ${eventId}; skipping tickets capture.`);
							const blockedHtmlPath = path.join(eventsDir, `${base}-tickets-blocked.html`);
							await saveHtml({ page: eventPage, filePath: blockedHtmlPath });
							const blockedShotPath = path.join(eventsDir, `${base}-tickets-blocked.png`);
							await eventPage.screenshot({ path: blockedShotPath, fullPage: true });
							continue;
						}

						const ticketsHtmlPath = path.join(eventsDir, `${base}-tickets.html`);
						await saveHtml({ page: eventPage, filePath: ticketsHtmlPath });
						const ticketsShotPath = path.join(eventsDir, `${base}-tickets.png`);
						await eventPage.screenshot({ path: ticketsShotPath, fullPage: true });
						console.log(`Saved: ${ticketsHtmlPath}`);
					} else {
						console.log('No "Get Tickets" link found on event detail page.');
					}

					if (Number.isFinite(delayMs) && delayMs > 0) {
						if (interactive && !delayMsProvided) {
							console.log(`Cooldown: waiting ${delayMs}ms before continuing...`);
						}
						await sleep(delayMs);
					}
			}

			if (exportXlsx) {
				const jsonPath = path.join(artifactsDir, 'events.json');
				await fs.writeFile(jsonPath, JSON.stringify(scraped, null, 2), 'utf8');
				await writeXlsx({ rows: scraped, filePath: xlsxPath });
				console.log(`Saved events JSON: ${jsonPath}`);
				console.log(`Saved events XLSX: ${xlsxPath}`);
			}
		}

		if (interactive && keepOpen) {
			await promptEnter('Press Enter to close the browser... ', { skipIfNoTty: true });
		}
	} finally {
		await browser.close();
	}
}

main().catch((err) => {
	const name = String(err?.name || '');
	const code = String(err?.code || '');
	if (name === 'AbortError' || code === 'ABORT_ERR') {
		console.log('Aborted by user (Ctrl+C).');
		process.exit(130);
	}
	console.error(err);
	process.exit(1);
});
