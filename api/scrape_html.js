// /api/debug-render.js
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  const targetDomain = 'https://jesoutiens.fondationsaintluc.be';
  const targetUrl = `${targetDomain}/fr-FR/project/2-wheels-4-purpose?tab=vue-d-ensemble`;

  const wantFull = String(req.query.full || '') === '1';
  const wantPretty = String(req.query.pretty || '') === '1';
  const TRUNCATE_AT = 100_000;

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

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    // scroll to bottom
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0;
        const step = 600;
        const timer = setInterval(() => {
          window.scrollBy(0, step);
          y += step;
          if (y >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 150);
      });
    });
    await sleep(3000);

    // Grab HTML after JS execution
    let html = await page.evaluate(() => document.documentElement.outerHTML);

    // Rewrite relative asset URLs to absolute pointing back to targetDomain
    html = html
      .replace(/(src|href)="\/(?!\/)/g, `$1="${targetDomain}/`);

    // Optional pretty print
    if (wantPretty) {
      html = html.replace(/></g, '>\n<').replace(/\n\s+\n/g, '\n');
    }

    const payload = wantFull ? html : html.slice(0, TRUNCATE_AT);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-HTML-Length', String(html.length));
    res.setHeader(
      'X-HTML-Truncated',
      wantFull ? 'false' : html.length > TRUNCATE_AT ? 'true' : 'false'
    );
    res.status(200).send(payload);
  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    console.error(error);
    res.status(500).json({ error: 'Render failed', details: error.message });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
};
