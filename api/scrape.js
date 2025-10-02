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
        
        // --- DATA EXTRACTION ---
        // The selectors are now based on the exact HTML structure you provided.
        const extractedData = await page.evaluate(() => {
            // Selector for the total contribution amount span
            const amountElement = document.querySelector('.statistic .value span');
            let totalAmount = 0;

            if (amountElement) {
                const rawText = amountElement.innerText;
                const cleanedText = rawText.replace(/€/g, '').replace(/\s/g, '').trim();
                totalAmount = parseInt(cleanedText, 10) || 0;
            }

            // Select all contributor list items within the correct container
            const contributorElements = document.querySelectorAll('div.block ul.contributions__ul li.contribution');
            const contributors = [];
            
            contributorElements.forEach(el => {
                const nameElement = el.querySelector('.contribution__name');
                const amountElement = el.querySelector('.contribution__amount');

                const name = nameElement ? nameElement.innerText.trim() : '';
                const amount = amountElement ? amountElement.innerText.trim() : '';

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
        res.status(500).json({ 
            error: 'Failed to scrape the page.',
            details: error.message 
        });
        return;
    } finally {
        if (browser !== null) {
            await browser.close();
        }
    }

    // --- SEND THE JSON RESPONSE ---
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json(result);
};

