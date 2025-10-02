// This is a Vercel serverless function
// It will be accessible at your-deployment-url/api/scrape

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// The main handler for the serverless function
module.exports = async (req, res) => {
    // URL of the page to scrape
    const urlToScrape = 'https://jesoutiens.fondationsaintluc.be/fr-FR/project/2-wheels-4-purpose';

    let browser = null;
    let result = null;

    try {
        // Launch a headless browser instance using the updated chromium package.
        browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--single-process'
            ],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();
        
        // Block unnecessary resources like images and CSS to speed up loading
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Navigate to the page and wait for it to be fully loaded
        await page.goto(urlToScrape, { waitUntil: 'networkidle2' });
        
        // --- UPDATED INTERACTION LOGIC ---

        // 1. Wait for the project title to be visible. This is a more reliable
        //    indicator that the page's initial JavaScript has rendered.
        const coreContentSelector = '.project__title';
        await page.waitForSelector(coreContentSelector, { visible: true, timeout: 20000 });

        // 3. Wait for the contributor list to appear.
        const contributorListSelector = 'li.contribution .contribution__name';
        await page.waitForSelector(contributorListSelector, { visible: true, timeout: 10000 });


        // --- DATA EXTRACTION ---
        // Now that we've waited for the data to be visible, we can extract it.
        const extractedData = await page.evaluate(() => {
            // Selector for the total contribution amount span
            const amountElement = document.querySelector('.statistic .value span');
            let totalAmount = 0; // Default to 0

            if (amountElement) {
                const rawText = amountElement.innerText; // e.g., "520&nbsp;€"
                // Remove currency symbols, non-breaking spaces, and trim whitespace
                const cleanedText = rawText.replace(/€/g, '').replace(/\s/g, '').trim();
                // Convert the cleaned string to an integer
                totalAmount = parseInt(cleanedText, 10) || 0;
            }

            // Select all contributor list items
            const contributorElements = document.querySelectorAll('li.contribution');
            const contributors = [];
            
            contributorElements.forEach(el => {
                const nameElement = el.querySelector('.contribution__name');
                const amountElement = el.querySelector('.contribution__amount');

                const name = nameElement ? nameElement.innerText.trim() : '';
                const amount = amountElement ? amountElement.innerText.trim() : '';

                // Check for anonymous donors and only add valid entries
                if (name && name.toLowerCase() !== 'anonyme') {
                    contributors.push({
                        name: name,
                        amount: amount
                    });
                }
            });

            return {
                total_contribution_amount: totalAmount,
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

