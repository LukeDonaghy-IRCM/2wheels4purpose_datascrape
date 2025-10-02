// This is a Vercel serverless function
// It will be accessible at your-deployment-url/api/scrape

const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');

// The main handler for the serverless function
module.exports = async (req, res) => {
    // URL of the page to scrape
    const urlToScrape = 'https://jesoutiens.fondationsaintluc.be/fr-FR/project/2-wheels-4-purpose';

    let browser = null;
    let result = null;

    try {
        // Launch a headless browser instance
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: true, // Use the new headless mode
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();
        
        // Block unnecessary resources like images and CSS to speed up loading
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Navigate to the page and wait for it to be fully loaded
        await page.goto(urlToScrape, { waitUntil: 'networkidle2' });
        
        // --- DATA EXTRACTION ---
        // We run JavaScript inside the context of the scraped page to get the data
        const extractedData = await page.evaluate(() => {
            // Selector for the total contribution amount
            const amountElement = document.querySelector('.project-stats-item--main .project-stats-item-value strong');
            const totalAmountText = amountElement ? amountElement.innerText : '€0';

            // Selector for the list of individual contributors
            const contributorElements = document.querySelectorAll('.supporter-item .supporter-item__name');
            const contributors = [];
            contributorElements.forEach(el => {
                // Check for anonymous donors and format accordingly
                const name = el.innerText.trim();
                if (name && name.toLowerCase() !== 'anonyme') {
                    contributors.push(name);
                }
            });

            return {
                total_contribution_amount: totalAmountText,
                contributors: contributors,
            };
        });

        result = extractedData;

    } catch (error) {
        console.error(error);
        // If an error occurs, send a server error status and a message
        res.status(500).json({ 
            error: 'Failed to scrape the page.',
            details: error.message 
        });
        return; // Stop execution
    } finally {
        // Ensure the browser is closed
        if (browser !== null) {
            await browser.close();
        }
    }

    // --- SEND THE JSON RESPONSE ---
    // Set the response header to indicate the content is JSON
    res.setHeader('Content-Type', 'application/json');
    // Set caching headers to cache the response for 5 minutes (300 seconds)
    // This prevents re-scraping on every single request, saving resources.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    
    // Send the successful JSON response
    res.status(200).json(result);
};
