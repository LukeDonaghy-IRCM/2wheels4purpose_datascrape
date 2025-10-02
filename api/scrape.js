// This is a Vercel serverless function
// It will be accessible at your-deployment-url/api/scrape

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// The main handler for the serverless function
module.exports = async (req, res) => {
    // URL of the page to load
    const urlToScrape = 'https://jesoutiens.fondationsaintluc.be/fr-FR/project/2-wheels-4-purpose';

    let browser = null;
    let projectTitle = '';

    try {
        // Launch a headless browser instance.
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
        
        // Navigate to the page and wait for it to be fully loaded.
        await page.goto(urlToScrape, { waitUntil: 'networkidle2', timeout: 25000 });
        
        // --- DATA EXTRACTION ---

        // 1. Define the selector for the project title.
        const titleSelector = '.project__title';
                
        // 3. Extract the text content of the title element.
        projectTitle = await page.evaluate((selector) => {
            const el = document.querySelector(selector);
            return el ? el.innerText : 'Title not found';
        }, titleSelector);


    } catch (error) {
        console.error(error);
        res.status(500).json({ 
            error: 'Failed to load the page or find the title.',
            details: error.message 
        });
        return; // Stop execution on error
    } finally {
        // Ensure the browser is always closed.
        if (browser !== null) {
            await browser.close();
        }
    }

    // --- SEND THE SUCCESS RESPONSE ---
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({ project_title: projectTitle });
};

