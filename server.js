const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const TurndownService = require("turndown");

const app = express();
// CHANGED: Use the port Render provides, or 3001 for local development
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const turndownService = new TurndownService();

// BEST PRACTICE: Add a helper function to validate the URL format
const isValidUrl = (urlString) => {
	try {
		const url = new URL(urlString);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch (_) {
		return false;
	}
};

const scrapePage = async (url) => {
	try {
		const { data } = await axios.get(url, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
			},
			timeout: 15000, // Added a timeout for safety
		});
		const $ = cheerio.load(data);

		const title =
			$("div.single h1.post-title").text().trim() ||
			$("h1.entry-title").text().trim() ||
			$("h1").first().text().trim();
		const contentHtml = $("section.story-content").html();
		const nextPageLink = $(
			'#story-parts h4:has(i.material-icons:contains("keyboard_arrow_right")) a'
		).attr("href");

		// BEST PRACTICE: More robust check
		if (!title || !contentHtml) {
			throw new Error(
				`Could not find title or content on ${url}. The website's structure may have changed.`
			);
		}

		const markdownContent = turndownService.turndown(contentHtml);

		return { title, markdownContent, nextPageLink };
	} catch (error) {
		console.error(`Error details for ${url}: ${error.message}`);
		if (axios.isAxiosError(error)) {
			if (error.response?.status === 404)
				throw new Error(`Page not found at ${url}.`);
			throw new Error(
				`Failed to fetch the page at ${url}. It may be down or blocking requests.`
			);
		}
		throw error; // Re-throw other errors
	}
};

// NEW: Health check endpoint for keep-alive services
app.get("/health", (req, res) => {
	res.status(200).json({ status: "ok" });
});

app.post("/scrape", async (req, res) => {
	const { url } = req.body;

	// CHANGED: Use the validation function
	if (!url || !isValidUrl(url)) {
		return res.status(400).json({ error: "A valid URL is required." });
	}

	try {
		let currentUrl = url;
		let fullMarkdownContent = "";
		let mainTitle = "";
		let pageCount = 0;
		const pageLimit = 20;

		while (currentUrl && pageCount < pageLimit) {
			console.log(`[Page ${pageCount + 1}] Scraping: ${currentUrl}`);
			const { title, markdownContent, nextPageLink } = await scrapePage(
				currentUrl
			);
			pageCount++;

			if (!mainTitle) mainTitle = title;
			if (pageCount > 1) fullMarkdownContent += "\n\n---\n\n";
			fullMarkdownContent += `## ${title}\n\n${markdownContent}`;

			currentUrl = nextPageLink ? new URL(nextPageLink, currentUrl).href : null;
		}

		// CHANGED: Better error for not finding content
		if (pageCount === 0 || !fullMarkdownContent.trim()) {
			return res.status(404).json({
				error:
					"Scraping complete, but no valid content was found. Please check the URL and website structure.",
			});
		}

		console.log(`Successfully scraped ${pageCount} pages.`);
		res.json({ title: mainTitle, content: fullMarkdownContent.trim() });
	} catch (error) {
		// Send a more specific error message back to the client
		res
			.status(500)
			.json({ error: error.message || "An unexpected server error occurred." });
	}
});

app.listen(PORT, () => {
	// Log the actual port the server is running on
	console.log(`Server is running on port ${PORT}`);
});
