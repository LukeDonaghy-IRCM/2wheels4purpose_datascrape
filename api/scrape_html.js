// /api/debug-render.js
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  const targetUrl =
    'https://jesoutiens.fondationsaintluc.be/fr-FR/project/2-wheels-4-purpose?tab=vue-d-ensemble';

  const wantFull = String(req.query.full || '') === '1';
  const wantPretty = String(req.query.pretty || '') === '1';
  const TRUNCATE_AT = 100_000; // chars

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

    // A realistic UA helps some SPA/CDN stacks
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Optional: log JSON responses to verify network activity (shows in Vercel logs)
    page.on('response', async (resp) => {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('application/json')) {
          console.log('[json]', resp.url());
        }
      } catch {}
    });

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    // Best-effort cookie banner accept (non-fatal)
    try {
      const btn = await page.$('#onetrust-accept-btn-handler');
      if (btn) await btn.click().catch(() => {});
    } catch {}

    // Scroll to bottom to trigger lazy content
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

    // Give any in-flight requests a moment to finish
    await sleep(3000);

    // Grab rendered HTML
    let html = await page.evaluate(() => document.documentElement.outerHTML);

    // Optional pretty print (lightweight)
    if (wantPretty) {
      html = html
        .replace(/></g, '>\n<')          // add newlines between tags
        .replace(/\n\s+\n/g, '\n');      // collapse extra blank lines
    }

    // Return either full or truncated HTML
    const payload = wantFull ? html : html.slice(0, TRUNCATE_AT);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Helpful header so you know if it was truncated
    res.setHeader('X-HTML-Length', String(html.length));
    res.setHeader('X-HTML-Truncated', wantFull ? 'false' : (html.length > TRUNCATE_AT ? 'true' : 'false'));
    res.status(200).send(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Render failed', details: error.message });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
};
