const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async (req, res) => {
  const url =
    'https://jesoutiens.fondationsaintluc.be/fr-FR/project/2-wheels-4-purpose?tab=vue-d-ensemble';

  let browser;
  try {
    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--single-process',
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // --- Capture contributions API response
    let contributionsData = null;
    page.on('response', async (resp) => {
      const url = resp.url();
      if (url.includes('/projects/2-wheels-4-purpose/contributions')) {
        try {
          const json = await resp.json();
          contributionsData = json;
        } catch (e) {
          console.error('[parse error]', e.message);
        }
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    // Trigger lazy loading by scrolling down
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0;
        const step = 500;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          y += step;
          if (y >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 200);
      });
    });

    // wait a bit for the API call
    await sleep(4000);

    if (!contributionsData) {
      return res.status(500).json({
        error: 'No contributions API response captured',
      });
    }

    // normalize the data
    const contributors = (contributionsData.data || contributionsData.items || [])
      .map((c) => ({
        name:
          (c.name || c.donorName || c.contributorName || c.contributor || '').trim(),
        amount_label:
          (c.amountFormatted || c.amount_label || c.amount || c.value || '').trim(),
      }))
      .filter(
        (c) => c.name && !/^(anonyme|anonymous)$/i.test(c.name)
      );

    const payload = {
      total_contributions_count:
        contributionsData.total ||
        contributionsData.count ||
        contributionsData.totalCount ||
        contributors.length,
      contributors,
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json(payload);

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: 'Failed to scrape the contribution data.',
      details: error.message,
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
};
