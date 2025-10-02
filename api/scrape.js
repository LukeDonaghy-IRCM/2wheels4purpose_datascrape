// This is a Vercel serverless function
// It will be accessible at your-deployment-url/api/scrape

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// The main handler for the serverless function
module.exports = async (req, res) => {
    // URL of the page to load
    const urlToScrape = 'https://jesoutiens.fondationsaintluc.be/fr-FR/project/2-wheels-4-purpose';

    let browser = null;
    let projectTitle = 'Title not found';
    let totalAmount = 'Amount not found';

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

        // Get the title directly from the browser tab (<title> tag).
        const pageTitle = await page.title(); // e.g., "2Wheels 4Purpose | Fondation Saint-Luc"

        // Clean up the title to get just the project name.
        if (pageTitle && pageTitle.includes('|')) {
            projectTitle = pageTitle.split('|')[0].trim();
        } else if (pageTitle) {
            projectTitle = pageTitle;
        }

        // --- EXTRACT TOTAL AMOUNT ---
        const amountSelector = 'span[data-v-c49acc64-s]';
        const totalAmount = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (!el) return 'Amount not found';
            
            // Get raw text e.g., "520&nbsp;€"
            const rawText = el.innerText;
            // Remove currency symbols, non-breaking spaces, and trim whitespace.
            const cleanedText = rawText.replace(/€/g, '').replace(/\s/g, '').trim();
            return cleanedText;
        }, amountSelector);


    } catch (error) {
        console.error(error);
        res.status(500).json({ 
            error: 'Failed to load the page or find the data.',
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
    res.status(200).json({
        project_title: projectTitle,
        total_contribution_amount: cleanedText
    });
};

