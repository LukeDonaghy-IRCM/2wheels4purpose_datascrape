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

    // ---- log all JSON responses ----
    page.on('response', async (resp) => {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('application/json')) {
          console.log('[json]', resp.url());
          const txt = await resp.text();
          console.log('[json payload snippet]', txt.slice(0, 200));
        }
      } catch (e) {
        console.log('[json error]', e.message);
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    // scroll down to trigger lazy content
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

    await sleep(4000);

    // ---- dump contribution block HTML ----
    const snippet = await page.evaluate(() => {
      const el = document.querySelector('ul[class*="contribution"], ul.contributions__ul, ul.contributions__list');
      return el ? el.innerHTML : 'no contribution list found';
    });
    console.log('[contrib block]', snippet.slice(0, 500));

    await browser.close();

    res.status(200).json({ status: 'ok - check function logs for output' });
  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};
