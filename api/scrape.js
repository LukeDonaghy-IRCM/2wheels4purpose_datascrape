// This is a Vercel serverless function
// It uses browser automation to scrape the data after it loads on the page.

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// The main handler for the serverless function
module.exports = async (req, res) => {
    // URL of the page to load
    const urlToScrape = 'https://jesoutiens.fondationsaintluc.be/fr-FR/project/2-wheels-4-purpose';

    let browser = null;
    let extractedData = {};

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
        A
        // Navigate to the page and wait for all network activity to settle.
        await page.goto(urlToScrape, { waitUntil: 'networkidle2', timeout: 25000 });
        
        // --- DATA EXTRACTION ---

        // 1. Wait for the main container of the contributions list to appear.
        // The user has indicated this loads automatically.
        const contributionsContainerSelector = 'ul.contributions__ul';
        await page.waitForSelector(contributionsContainerSelector, { visible: true, timeout: 15000 });

        // 2. Extract all the required information in one step.
        extractedData = await page.evaluate(() => {
            // Extract the total number of contributions.
            const countElement = document.querySelector('p > strong.bold.color--prim');
            const totalContributions = countElement ? parseInt(countElement.innerText.trim(), 10) : 0;

            // Extract the list of individual contributors.
            const contributorElements = document.querySelectorAll('li.contribution');
            const contributorsList = [];
            
            contributorElements.forEach(el => {
                const nameElement = el.querySelector('.contribution__name');
                const amountElement = el.querySelector('.contribution__amount');

                const name = nameElement ? nameElement.innerText.trim() : 'N/A';
                const amount = amountElement ? amountElement.innerText.trim() : 'N/A';

                // Only add valid entries.
                if (name.toLowerCase() !== 'anonyme' && name !== 'N/A') {
                    contributorsList.push({
                        name: name,
                        amount: amount
                    });
                }
            });

            return {
                total_contributions_count: totalContributions,
                contributors: contributorsList
            };
        });


    } catch (error) {
        console.error(error);
        res.status(500).json({ 
            error: 'Failed to scrape the contribution data.',
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
    res.status(200).json(extractedData);
};

