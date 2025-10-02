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
        
        // Block unnecessary resources to speed up loading.
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Navigate to the page and wait for it to be fully loaded.
        await page.goto(urlToScrape, { waitUntil: 'networkidle2' });
        
        // --- SEQUENTIAL DATA EXTRACTION ---

        // 1. Wait for the main statistic block to be visible.
        const statisticSelector = '.statistic .value span';
        await page.waitForSelector(statisticSelector, { visible: true, timeout: 15000 });

        // 2. Extract the total amount, which is visible on the initial page load.
        const totalAmount = await page.evaluate((selector) => {
            const amountElement = document.querySelector(selector);
            return amountElement ? amountElement.innerText : '0 €';
        }, statisticSelector);

        // 4. Wait for the contributor list container to appear after the click.
        const contributorListSelector = 'ul.contributions__ul';
        await page.waitForSelector(contributorListSelector, { visible: true, timeout: 10000 });

        // 5. Extract the list of contributors.
        const contributors = await page.evaluate((selector) => {
            const contributorElements = document.querySelectorAll(`${selector} li.contribution`);
            const contributorList = [];
            
            contributorElements.forEach(el => {
                const nameElement = el.querySelector('.contribution__name');
                const amountElement = el.querySelector('.contribution__amount');
                const name = nameElement ? nameElement.innerText.trim() : '';
                const amount = amountElement ? amountElement.innerText.trim() : '';

                if (name && name.toLowerCase() !== 'anonyme') {
                    contributorList.push({ name, amount });
                }
            });
            return contributorList;
        }, contributorListSelector);

        // 6. Assemble the final result.
        result = {
            total_contribution_amount: totalAmount,
            contributors: contributors,
        };

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

