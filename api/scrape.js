// /api/scrape.js
const chromium = require('@sparticuz/chromium');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteerExtra.use(StealthPlugin());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  const targetUrl = 'https://jesoutiens.fondationsaintluc.be/fr-FR/project/2-wheels-4-purpose?tab=vue-d-ensemble';

  // prefer "new" (Chrome 112+ headless) → fallback to false → fallback to true
  const tryLaunch = async () => {
    const base = {
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--single-process',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--lang=fr-FR,fr'
      ],
      defaultViewport: { width: 1366, height: 768 },
      executablePath: await chromium.executablePath(),
      ignoreHTTPSErrors: true
    };
    for (const mode of ['new', false, true]) {
      try {
        const browser = await puppeteerExtra.launch({ ...base, headless: mode });
        return browser;
      } catch (e) {
        console.warn(`launch failed (headless=${mode}) → ${e.message}`);
      }
    }
    // final attempt: strict headless true
    return puppeteerExtra.launch({ ...base, headless: true });
  };

  let browser;
  try {
    browser = await tryLaunch();
    const page = await browser.newPage();

    // Stealthy page signals (before navigation)
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
    });

    // Manual shims (complement the stealth plugin)
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      // fake chrome runtime object
      window.chrome = { runtime: {} };
      // permissions shim
      const oq = navigator.permissions && navigator.permissions.query;
      if (oq) {
        navigator.permissions.query = (p) =>
          p && p.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : oq(p);
      }
    });

    // Navigate
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    // Accept cookie banner (best-effort, non-fatal)
    try {
      const btn = await page.$('#onetrust-accept-btn-handler');
      if (btn) await btn.click().catch(() => {});
    } catch {}

    // Scroll to bottom to trigger any lazy blocks
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0;
        const step = 600;
        const id = setInterval(() => {
          window.scrollBy(0, step);
          y += step;
          if (y >= document.body.scrollHeight) {
            clearInterval(id);
            resolve();
          }
        }, 150);
      });
    });
    await sleep(3000);

    // Extract contributors from DOM (broad, resilient selectors)
    const extracted = await page.evaluate(() => {
      const getText = (el) => (el ? el.textContent.trim() : '');
      // try common containers
      let list =
        document.querySelector('ul.contributions__ul') ||
        document.querySelector('ul.contributions__list') ||
        document.querySelector('ul[class*="contribution"]');

      if (!list) {
        // heuristic: any UL whose text includes €
        for (const u of Array.from(document.querySelectorAll('ul'))) {
          if (/[€]/.test(u.innerText)) { list = u; break; }
        }
      }
      const rows = list ? Array.from(list.querySelectorAll('li')) : [];

      const items = rows.map((row) => {
        const nameEl =
          row.querySelector('.contribution__name') ||
          row.querySelector('[class*="name"]') ||
          row.querySelector('strong') ||
          row.querySelector('b') ||
          row.querySelector('span');
        const amtEl =
          row.querySelector('.contribution__amount') ||
          row.querySelector('[class*="amount"]') ||
          Array.from(row.querySelectorAll('span, strong, b')).reverse().find(el => /[€\d]/.test(el.textContent));
        return { name: getText(nameEl), amount_label: getText(amtEl) };
      }).filter(x => x.name);

      // try to find a visible total count nearby
      let total = null;
      const countEl =
        document.querySelector('[data-testid="contributions-count"]') ||
        document.querySelector('strong.bold.color--prim') ||
        document.querySelector('strong.color--prim');
      if (countEl && /\d/.test(countEl.textContent)) {
        total = parseInt(countEl.textContent.replace(/\D+/g, ''), 10);
      }

      return { items, total };
    });

    // Clean + normalize
    const contributors = (extracted.items || [])
      .filter(c => c.name && !/^(anonyme|anonymous)$/i.test(c.name))
      .map(c => ({ name: c.name, amount_label: c.amount_label || '' }));

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({
      total_contributions_count: extracted.total != null ? extracted.total : contributors.length,
      contributors
    });
  } catch (err) {
    console.error('scrape-error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
};
