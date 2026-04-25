const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const TurndownService = require("turndown");
const puppeteer = require("puppeteer-core");

const app = express();
// CHANGED: Use the port Render provides, or 3001 for local development
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const turndownService = new TurndownService();

// ── Short-lived page cache (avoids double-fetch when /scrape detects listing then /scrape-series re-fetches) ──
const pageCache = new Map();
const PAGE_CACHE_TTL = 60000; // 60 seconds

// BEST PRACTICE: Add a helper function to validate the URL format
const isValidUrl = (urlString) => {
	try {
		const url = new URL(urlString);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch (_) {
		return false;
	}
};

// ── Headless browser fetcher (Cloudflare bypass) ──
let browserInstance = null;

const getBrowser = async () => {
	if (browserInstance) return browserInstance;

	const fs = require("fs");
	const os = require("os");
	let executablePath;
	let launchArgs = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
	let defaultViewport = { width: 1280, height: 800 };
	let headlessMode = "new";

	// Check for local Chrome first (macOS, Windows, common Linux)
	const localPaths = [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium-browser",
		"/usr/bin/chromium",
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	];
	const localChrome = localPaths.find((p) => fs.existsSync(p));

	if (localChrome) {
		console.log(`[Browser] Using local Chrome: ${localChrome}`);
		executablePath = localChrome;
	} else {
		// Serverless fallback: use @sparticuz/chromium (only works on Linux)
		try {
			const chromium = require("@sparticuz/chromium");
			executablePath = await chromium.executablePath();
			launchArgs = chromium.args;
			defaultViewport = chromium.defaultViewport;
			headlessMode = chromium.headless;
			console.log(`[Browser] Using @sparticuz/chromium`);
		} catch (e) {
			throw new Error("No Chrome/Chromium binary found. Install Chrome or set CHROME_PATH.");
		}
	}

	browserInstance = await puppeteer.launch({
		args: launchArgs,
		defaultViewport,
		executablePath,
		headless: headlessMode,
	});

	return browserInstance;
};

// ── Fetch page HTML using headless browser ──
// Each request uses a fresh incognito context (clean cookies/state)
// so Cloudflare treats it as a new visitor and skips Turnstile challenges.
const fetchWithBrowser = async (url, retryCount = 0) => {
	const MAX_RETRIES = 2;

	console.log(`[Puppeteer] Fetching: ${url}`);

	// Reset stale browser
	if (browserInstance && !browserInstance.isConnected()) {
		console.log(`[Browser] Previous instance disconnected, creating fresh one.`);
		browserInstance = null;
	}

	let browser, context, page;

	try {
		browser = await getBrowser();
		context = await browser.createBrowserContext();
		page = await context.newPage();
	} catch (err) {
		if (retryCount < MAX_RETRIES) {
			console.log(`[Browser] Failed to create context (attempt ${retryCount + 1}/${MAX_RETRIES}), retrying...`);
			browserInstance = null;
			await new Promise(r => setTimeout(r, 2000));
			return fetchWithBrowser(url, retryCount + 1);
		}
		throw new Error(`Browser context creation failed after ${MAX_RETRIES} retries: ${err.message}`);
	}

	try {
		await page.setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
		);
		await page.setExtraHTTPHeaders({
			"Accept-Language": "en-US,en;q=0.9",
			"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		});

		try {
			await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
		} catch (navError) {
			// Handle browser crashes during navigation
			if (navError.message.includes('Session closed') || navError.message.includes('Target closed')) {
				if (retryCount < MAX_RETRIES) {
					console.log(`[Browser] Navigation failed (session closed), retrying...`);
					await page.close().catch(() => {});
					await context.close().catch(() => {});
					browserInstance = null;
					await new Promise(r => setTimeout(r, 2000));
					return fetchWithBrowser(url, retryCount + 1);
				}
			}
			throw navError;
		}

		// Detect Cloudflare "Just a moment..." challenge page
		const isChallenge = await page.evaluate(() =>
			document.title === "Just a moment..."
		);

		if (isChallenge) {
			console.log(`[Puppeteer] Cloudflare challenge detected, waiting for auto-resolve...`);
			try {
				await page.waitForFunction(
					() => document.title !== "Just a moment...",
					{ timeout: 30000 }
				);
				await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
				console.log(`[Puppeteer] Cloudflare challenge resolved!`);
			} catch (e) {
				console.log(`[Puppeteer] Cloudflare challenge did not resolve within 30s`);
			}
		}

		// Poll for real content (listing page or story page)
		const maxWait = 10000;
		const pollInterval = 1500;
		let elapsed = 0;

		while (elapsed < maxWait) {
			const hasContent = await page.evaluate(() => {
				const h1 = document.querySelector('h1');
				const storyContent = document.querySelector('.story-content, .entry-content, article');
				const listingContent = document.querySelector('section.stories');
				return !!(h1 && storyContent) || !!(listingContent && listingContent.querySelectorAll('article').length >= 2);
			});

			if (hasContent) {
				console.log(`[Puppeteer] Content appeared after ${elapsed}ms`);
				break;
			}

			console.log(`[Puppeteer] Waiting for content... (${elapsed}ms)`);
			await new Promise((r) => setTimeout(r, pollInterval));
			elapsed += pollInterval;
		}

		// Extra settle time for any lazy-loaded elements
		await new Promise((r) => setTimeout(r, 1000));

		return await page.content();
	} finally {
		await page.close();
		await context.close();
	}
};

// ── Fetch page HTML using axios (fast path) ──
const fetchWithAxios = async (url) => {
	let origin;
	try { origin = new URL(url).origin; } catch (e) { origin = url; }

	const { data } = await axios.get(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
			"Accept-Encoding": "gzip, deflate, br",
			"Referer": origin + "/",
			"Connection": "keep-alive",
			"Upgrade-Insecure-Requests": "1",
			"Sec-Fetch-Dest": "document",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Site": "same-origin",
			"Cache-Control": "max-age=0",
		},
		timeout: 20000,
		maxRedirects: 5,
	});

	return data;
};

// ── Fetch page HTML with automatic Axios → Puppeteer fallback ──
const fetchPageUncached = async (url) => {
	try {
		return await fetchWithAxios(url);
	} catch (axiosError) {
		const status = axiosError.response?.status;
		if (status === 403 || status === 503) {
			console.log(`[Fallback] Axios got ${status}, switching to Puppeteer for: ${url}`);
			try {
				return await fetchWithBrowser(url);
			} catch (browserError) {
				throw new Error(
					`Failed to fetch ${url}. Blocked by site protection (tried headless browser). Error: ${browserError.message}`
				);
			}
		} else if (status === 404) {
			throw new Error(`Page not found at ${url}.`);
		} else {
			throw new Error(
				`Failed to fetch the page at ${url}. (HTTP ${status || "timeout/network error"})`
			);
		}
	}
};

// ── Cached fetch — avoids double-fetching pages that were recently loaded ──
const fetchPage = async (url) => {
	const cached = pageCache.get(url);
	if (cached && Date.now() - cached.ts < PAGE_CACHE_TTL) {
		console.log(`[Cache] Hit for: ${url}`);
		return cached.html;
	}

	const html = await fetchPageUncached(url);
	pageCache.set(url, { html, ts: Date.now() });

	// Evict stale entries
	for (const [key, val] of pageCache) {
		if (Date.now() - val.ts > PAGE_CACHE_TTL) pageCache.delete(key);
	}

	return html;
};

// ── Parse a single story page's HTML into structured content ──
const parsePageContent = (html, url) => {
	const $ = cheerio.load(html);

	const title =
		$("h1.post-title").text().trim() ||
		$("div.single h1.post-title").text().trim() ||
		$("h1.entry-title").text().trim() ||
		$(".story-title h1").text().trim() ||
		$("article h1").text().trim() ||
		$("h1").first().text().trim();

	const author =
		$(".author-name a").text().trim() ||
		$(".story-author a").text().trim() ||
		$("a[href*='/author/']").first().text().trim() ||
		"";

	const contentHtml =
		$("section.story-content").html() ||
		$(".story-content").html() ||
		$(".entry-content").html() ||
		$("article .content").html() ||
		$(".post-content").html() ||
		"";

	const nextPageLink =
		$('#story-parts h4:has(i.material-icons:contains("keyboard_arrow_right")) a').attr("href") ||
		$('.story-nav a:contains("Next")').attr("href") ||
		$('a.next-page').attr("href") ||
		null;

	console.log(`[Parse] Title: "${title}", Author: "${author}", Content length: ${contentHtml.length}, Next: ${nextPageLink || "none"}`);

	if (!title || !contentHtml) {
		throw new Error(
			`Could not find title or content on ${url}. The website's structure may have changed.`
		);
	}

	const markdownContent = turndownService.turndown(contentHtml);
	const authorLine = author ? `*By ${author}*\n\n` : "";
	return { title, markdownContent: authorLine + markdownContent, nextPageLink };
};

// ── Core page scraper (fetch + parse) ──
const scrapePage = async (url) => {
	const html = await fetchPage(url);
	return parsePageContent(html, url);
};

// ── Series listing page detection ──
const detectListingPage = (html) => {
	const $ = cheerio.load(html);
	const storiesSection = $("section.stories");
	const articleCount = storiesSection.find("article").length;
	const hasPagination = $("section.pagination-container").length > 0
		|| $("ul.pagination").length > 0;

	return {
		isListing: articleCount >= 2 && (hasPagination || articleCount >= 5),
		articleCount,
		hasPagination,
	};
};

// ── Extract story links and pagination from a listing page ──
const extractListingData = (html, baseUrl) => {
	const $ = cheerio.load(html);
	const stories = [];

	$("section.stories article").each((_, el) => {
		const $el = $(el);
		const linkEl = $el.find("h2.post-title a");
		const href = linkEl.attr("href");
		if (!href) return;

		const fullUrl = new URL(href, baseUrl).href;
		const title = linkEl.text().trim();
		const date = $el.find("span.meta-date").text().replace("On", "").trim();
		const excerpt = $el.find("p.exceprt").text().trim();
		const category = $el.find("span.meta-category a").text().trim();
		const views = $el.find("span.meta-views").text().trim().replace(/,/g, "");

		stories.push({ url: fullUrl, title, date, excerpt, category, views });
	});

	// Pagination: find the last page number
	let lastPage = 1;
	$("ul.pagination a.page-numbers").each((_, el) => {
		const text = $(el).text().trim();
		const num = parseInt(text, 10);
		if (!isNaN(num) && num > lastPage) lastPage = num;
	});

	// Series name from page title or first h1
	const seriesName =
		$("h1.page-title").text().trim() ||
		$("h1").first().text().trim() ||
		$("title").text().trim().split("|")[0].trim() ||
		"Series";

	return { stories, lastPage, seriesName };
};

// ── Build a pagination URL for a given page number ──
const buildPageUrl = (baseUrl, pageNumber) => {
	const cleanUrl = baseUrl.replace(/\/page\/\d+\/?$/, "").replace(/\/?$/, "/");
	if (pageNumber <= 1) return cleanUrl;
	return `${cleanUrl}page/${pageNumber}/`;
};

// ── Series scraping orchestrator with SSE progress ──
const scrapeSeriesListing = async (url, sendEvent, req) => {
	const DELAY_BETWEEN_STORIES = 2000;
	const PAGE_LIMIT = 20;

	// Step 1: Fetch the first listing page
	console.log(`[Series] Fetching listing page: ${url}`);
	const firstPageHtml = await fetchPage(url);
	const { stories: firstPageStories, lastPage, seriesName } = extractListingData(firstPageHtml, url);

	const estimatedStories = firstPageStories.length * lastPage;
	sendEvent("detecting", { seriesName, totalPages: lastPage, estimatedStories });
	console.log(`[Series] "${seriesName}" — ${lastPage} pages, ~${estimatedStories} stories`);

	// Step 2: Traverse pages in REVERSE (last page has oldest stories)
	const allStories = [];

	for (let page = lastPage; page >= 1; page--) {
		if (req.aborted) {
			console.log(`[Series] Client disconnected, stopping.`);
			return;
		}

		let pageStories;
		if (page === 1) {
			// Already fetched page 1
			pageStories = firstPageStories;
		} else {
			const pageUrl = buildPageUrl(url, page);
			console.log(`[Series] Fetching page ${page}/${lastPage}: ${pageUrl}`);
			sendEvent("page_progress", { currentPage: page, totalPages: lastPage });
			try {
				const pageHtml = await fetchPage(pageUrl);
				const data = extractListingData(pageHtml, pageUrl);
				pageStories = data.stories;
			} catch (err) {
				console.log(`[Series] Failed to fetch page ${page}: ${err.message}`);
				sendEvent("page_error", { page, error: err.message });
				continue;
			}
		}

		// Within each page, stories are newest-first, so reverse them
		allStories.push(...pageStories.reverse());
	}

	// Step 3: Deduplicate by URL
	const seen = new Set();
	const uniqueStories = allStories.filter((s) => {
		if (seen.has(s.url)) return false;
		seen.add(s.url);
		return true;
	});

	console.log(`[Series] Total unique stories: ${uniqueStories.length}`);
	sendEvent("collecting_done", { totalStories: uniqueStories.length });

	// Step 4: Scrape each story
	let fullContent = "";
	const failedStories = [];
	const totalStories = uniqueStories.length;

	for (let i = 0; i < totalStories; i++) {
		if (req.aborted) {
			console.log(`[Series] Client disconnected, stopping at story ${i + 1}.`);
			return;
		}

		const story = uniqueStories[i];
		sendEvent("progress", { current: i + 1, total: totalStories, storyTitle: story.title });

		try {
			// In a series, each listing entry is one episode — do NOT follow nextPageLink
			// (nextPageLink would chain to the next episode, causing O(n²) redundancy)
			const html = await fetchPage(story.url);
			const { markdownContent } = parsePageContent(html, story.url);

			if (i > 0) fullContent += "\n\n---\n\n";
			fullContent += `## ${story.title}\n\n${markdownContent}`;

			console.log(`[Series] Scraped story ${i + 1}/${totalStories}: "${story.title}"`);
		} catch (err) {
			console.log(`[Series] Failed story ${i + 1}: "${story.title}" — ${err.message}`);
			failedStories.push({ index: i, url: story.url, title: story.title, error: err.message });
			sendEvent("story_error", { index: i + 1, url: story.url, title: story.title, error: err.message });

			if (i > 0) fullContent += "\n\n---\n\n";
			fullContent += `## ${story.title} (Failed to scrape)\n\n*Could not scrape this story. Error: ${err.message}*\n*URL: ${story.url}*`;
		}

		// Delay between stories to avoid rate limiting
		if (i < totalStories - 1) {
			await new Promise((r) => setTimeout(r, DELAY_BETWEEN_STORIES));
		}
	}

	// Step 5: Send final result
	sendEvent("done", {
		title: seriesName,
		content: fullContent.trim(),
		totalStories,
		failedStories: failedStories.length,
		seriesName,
	});

	console.log(`[Series] Complete. ${totalStories} stories, ${failedStories.length} failed.`);
};

// NEW: Health check endpoint for keep-alive services
app.get("/health", (req, res) => {
	res.status(200).json({ status: "ok" });
});

app.post("/scrape", async (req, res) => {
	const { url } = req.body;

	if (!url || !isValidUrl(url)) {
		return res.status(400).json({ error: "A valid URL is required." });
	}

	try {
		// Fetch HTML first to detect page type
		const html = await fetchPage(url);
		const detection = detectListingPage(html);

		if (detection.isListing) {
			return res.status(200).json({
				type: "listing_detected",
				articleCount: detection.articleCount,
				hasPagination: detection.hasPagination,
			});
		}

		// Single story: parse the already-fetched HTML
		let currentUrl = url;
		let fullMarkdownContent = "";
		let mainTitle = "";
		let pageCount = 0;
		const pageLimit = 20;

		// Parse first page from already-fetched HTML
		const firstPage = parsePageContent(html, url);
		pageCount++;
		mainTitle = firstPage.title;
		fullMarkdownContent += `## ${firstPage.title}\n\n${firstPage.markdownContent}`;
		currentUrl = firstPage.nextPageLink ? new URL(firstPage.nextPageLink, url).href : null;

		// Follow remaining pages
		while (currentUrl && pageCount < pageLimit) {
			console.log(`[Page ${pageCount + 1}] Scraping: ${currentUrl}`);
			const { title, markdownContent, nextPageLink } = await scrapePage(currentUrl);
			pageCount++;
			fullMarkdownContent += "\n\n---\n\n";
			fullMarkdownContent += `## ${title}\n\n${markdownContent}`;
			currentUrl = nextPageLink ? new URL(nextPageLink, currentUrl).href : null;
		}

		if (!fullMarkdownContent.trim()) {
			return res.status(404).json({
				error: "Scraping complete, but no valid content was found. Please check the URL and website structure.",
			});
		}

		console.log(`Successfully scraped ${pageCount} pages.`);
		res.json({ title: mainTitle, content: fullMarkdownContent.trim() });
	} catch (error) {
		res.status(500).json({ error: error.message || "An unexpected server error occurred." });
	}
});

// ── SSE endpoint for series scraping ──
app.post("/scrape-series", async (req, res) => {
	const { url } = req.body;

	if (!url || !isValidUrl(url)) {
		return res.status(400).json({ error: "A valid URL is required." });
	}

	// Set SSE headers
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no",
	});

	req.setTimeout(0);
	res.flushHeaders();

	let clientDisconnected = false;

	const sendEvent = (eventType, data) => {
		if (clientDisconnected) return;
		res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	// Listen on res (not req) — req.close fires when body is consumed, not on disconnect
	res.on("close", () => {
		clientDisconnected = true;
		console.log(`[Series SSE] Client disconnected.`);
	});

	// Pass a signal object so the orchestrator can check disconnect status
	const signal = { get aborted() { return clientDisconnected; } };

	try {
		await scrapeSeriesListing(url, sendEvent, signal);
	} catch (error) {
		sendEvent("error", { message: error.message || "An unexpected server error occurred." });
	} finally {
		if (!clientDisconnected) res.end();
	}
});

// Graceful shutdown: close browser on exit
process.on("SIGINT", async () => {
	if (browserInstance) await browserInstance.close();
	process.exit();
});

app.listen(PORT, "0.0.0.0", () => {
	// Log the actual port the server is running on
	console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
