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

// NEW: Function to scrape author page and get all story links
const scrapeAuthorPage = async (url) => {
	try {
		const { data } = await axios.get(url, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
			},
			timeout: 15000,
		});
		const $ = cheerio.load(data);
		const storyLinks = [];

		// Extract all story links from the author page
		$(".elementor-posts-container .elementor-post").each((index, element) => {
			const titleElement = $(element).find(".elementor-post__title a");
			const href = titleElement.attr("href");
			const title = titleElement.text().trim();
			const date = $(element).find(".elementor-post-date").text().trim();
			const excerpt = $(element)
				.find(".elementor-post__excerpt p")
				.text()
				.trim();

			if (href && title) {
				storyLinks.push({
					title,
					url: href,
					date,
					excerpt,
				});
			}
		});

		console.log(`Found ${storyLinks.length} stories on author page`);
		return storyLinks;
	} catch (error) {
		console.error(`Error scraping author page ${url}: ${error.message}`);
		throw error;
	}
};

// NEW: Function to scrape a single story with all its parts
const scrapeSingleStory = async (url) => {
	try {
		let currentUrl = url;
		let fullMarkdownContent = "";
		let mainTitle = "";
		let pageCount = 0;
		const pageLimit = 50;

		while (currentUrl && pageCount < pageLimit) {
			console.log(`  [Part ${pageCount + 1}] Scraping: ${currentUrl}`);
			const { title, markdownContent, nextPageLink } = await scrapePage(
				currentUrl
			);
			pageCount++;

			if (!mainTitle) mainTitle = title;
			if (pageCount > 1) fullMarkdownContent += "\n\n---\n\n";
			fullMarkdownContent += `### ${title}\n\n${markdownContent}`;

			currentUrl = nextPageLink ? new URL(nextPageLink, currentUrl).href : null;
		}

		return {
			title: mainTitle,
			content: fullMarkdownContent.trim(),
			partCount: pageCount,
		};
	} catch (error) {
		console.error(`Error scraping story ${url}: ${error.message}`);
		return {
			title: `Error scraping story`,
			content: `Failed to scrape story from ${url}: ${error.message}`,
			partCount: 0,
		};
	}
};

// NEW: Health check endpoint for keep-alive services
app.get("/health", (req, res) => {
	res.status(200).json({ status: "ok" });
});

// Original single story scraping endpoint
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
		const pageLimit = 50;
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

// NEW: Author scraping endpoint
app.post("/scrape-author", async (req, res) => {
	const { url } = req.body;

	if (!url || !isValidUrl(url)) {
		return res.status(400).json({ error: "A valid URL is required." });
	}

	// Check if URL contains /author/
	if (!url.includes("/author/")) {
		return res.status(400).json({
			error: "URL must contain '/author/' to use this endpoint.",
		});
	}

	try {
		console.log(`Starting author page scraping: ${url}`);

		// Step 1: Get all story links from author page
		const storyLinks = await scrapeAuthorPage(url);

		if (storyLinks.length === 0) {
			return res.status(404).json({
				error: "No stories found on the author page.",
			});
		}

		// Step 2: Scrape each story
		let fullAuthorContent = "";
		let successCount = 0;
		const authorName = url.split("/author/")[1].replace("/", "");

		fullAuthorContent += `# Stories by ${authorName}\n\n`;
		fullAuthorContent += `*Scraped ${storyLinks.length} stories from author page*\n\n`;
		fullAuthorContent += `---\n\n`;

		for (let i = 0; i < storyLinks.length; i++) {
			const story = storyLinks[i];
			console.log(
				`[Story ${i + 1}/${storyLinks.length}] Processing: ${story.title}`
			);

			const storyResult = await scrapeSingleStory(story.url);

			if (storyResult.partCount > 0) {
				successCount++;
			}

			// Add story to the compilation
			fullAuthorContent += `## ${story.title}\n\n`;
			if (story.date) {
				fullAuthorContent += `***Published:*** ${story.date}\n\n`;
			}
			if (story.excerpt) {
				fullAuthorContent += `***Synopsis:*** ${story.excerpt}\n\n`;
			}
			fullAuthorContent += `***Source:*** [${story.url}](${story.url})\n\n`;
			fullAuthorContent += `***Parts scraped:*** ${storyResult.partCount}\n\n`;
			fullAuthorContent += `${storyResult.content}\n\n`;
			fullAuthorContent += `---\n\n`;

			// Add a small delay to be respectful to the server
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}

		console.log(
			`Successfully scraped ${successCount}/${storyLinks.length} stories`
		);

		res.json({
			title: `Stories by ${authorName}`,
			content: fullAuthorContent.trim(),
			totalStories: storyLinks.length,
			successfullyScraped: successCount,
			storyList: storyLinks.map((story) => ({
				title: story.title,
				url: story.url,
				date: story.date,
			})),
		});
	} catch (error) {
		console.error(`Author scraping error: ${error.message}`);
		res.status(500).json({
			error:
				error.message ||
				"An unexpected error occurred while scraping author page.",
		});
	}
});

app.listen(PORT, () => {
	// Log the actual port the server is running on
	console.log(`Server is running on port ${PORT}`);
	console.log(`Available endpoints:`);
	console.log(`  POST /scrape - Scrape a single story`);
	console.log(`  POST /scrape-author - Scrape all stories from an author page`);
	console.log(`  GET /health - Health check`);
});
