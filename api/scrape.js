// /api/scrape-contributors-stealth.js
// Requires: puppeteer-extra, puppeteer-extra-plugin-stealth, puppeteer-core, @sparticuz/chromium
// Install in your project: npm i puppeteer-extra puppeteer-extra-plugin-stealth puppeteer-core @sparticuz/chromium

const chromium = require('@sparticuz/chromium');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const puppeteer = require('puppeteer-core'); // used only for types/options

// install stealth
puppeteerExtra.use(StealthPlugin());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  // change preference: "new" | false | true
  const HEADLESS_PREFERENCE = 'new'; 

  const targetUrl =
    'https://jesoutiens.fondationsaintluc.be/fr-FR/project/2-wheels-4-purpose?tab=vue-d-ensemble';

  let browser = null;
  try {
    // --- build launch options (chromium from sparticuz) ---
    const launchOpts = {
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--single-process',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--lang=fr-FR,fr',
      ],
      defaultViewport: { width: 1366, height: 768 },
      executablePath: await chromium.executablePath(),
      ignoreHTTPSErrors: true,
      headless: HEADLESS_PREFERENCE,
    };

    // Try fallbacks if preferred headless mode fails
    try {
      browser = await puppeteerExtra.launch(launchOpts);
    } catch (e1) {
      console.warn('launch with preferred headless failed, trying headless:false', e1.message);
      try {
        launchOpts.headless = false;
        browser = await puppeteerExtra.launch(launchOpts);
      } catch (e2) {
        console.warn('launch with headless:false failed, trying headless:true', e2.message);
        launchOpts.headless = true;
        browser = await puppeteerExtra.launch(launchOpts);
      }
    }

    const page = await browser.newPage();

    // --- Stealthy page tweaks (before any navigation) ---
    // Realistic UA
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    );

    // viewport / platform spoof
    await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });

    // Languages
    await page.evaluateOnNewDocument(() => {
      // navigator.webdriver -> false
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // languages
      Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en-US', 'en'] });
      // plugins (fake)
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
      // permissions - mimic allowing
      const originalQuery = window.navigator.permissions.query;
      try {
        window.navigator.permissions.query = (parameters) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
      } catch (e) {}
    });

    // further stealthy tweaks: override webdriver and chrome runtime and userAgent specifics
    await page.evaluateOnNewDocument(() => {
      // chrome runtime
      window.chrome = { runtime: {} };
      // webdriver false (redundant safe)
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // definePlatform
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      // timezone
      try { Intl.DateTimeFormat = Intl.DateTimeFormat; } catch (e) {}
    });

    // set extra headers (Referrer, Accept-Language) and cookies if needed
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    // Optional: set cookies similar to a real browser (cookie banner accepted if you know the cookie)
    // await page.setCookie({ name: 'koalect_consent', value: 'functiona analytics marketing', domain: 'jesoutiens.fondationsaintluc.be' });

    // listen to console from page (useful for debugging)
    page.on('console', (msg) => {
      try {
        const args = msg.args().map(a => a._remoteObject && a._remoteObject.value).slice(0, 5);
        console.log('[page]', msg.type(), args);
      } catch (e) {
        console.log('[page]', msg.type(), msg.text());
      }
    });

    // Navigate
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    // small wait for SPA
    await sleep(1000);

    // Accept cookie banner best-effort
    try {
      const cookieSelectors = [
        '#onetrust-accept-btn-handler',
        'button[aria-label*="Accepter"]',
        'button:contains("Accepter")',
        'button:contains("J’accepte")',
      ];
      for (const sel of cookieSelectors) {
        const el = await page.$(sel);
        if (el) { await el.click().catch(() => {}); break; }
      }
    } catch (e) {}

    // scroll to trigger lazy rendering / in-view fetches
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0;
        const step = 500;
        const interval = setInterval(() => {
          window.scrollBy(0, step);
          y += step;
          if (y >= document.body.scrollHeight) {
            clearInterval(interval);
            resolve();
          }
        }, 200);
      });
    });

    // extra wait
    await sleep(3500);

    // debug dump: scripts loaded & small html preview
    const debug = await page.evaluate(() => {
      return {
        scripts: Array.from(document.querySelectorAll('script')).map(s => s.src).slice(0, 40),
        htmlPreview: document.documentElement.outerHTML.slice(0, 2000)
      };
    });
    console.log('[debug scripts]', debug.scripts);
    // console.log('[debug htmlPreview]', debug.htmlPreview);

    // --- Extract contributors from DOM (safe selectors) ---
    const extracted = await page.evaluate(() => {
      // try multiple heuristics to find the contributions list
      const selectors = [
        'ul.contributions__ul',
        'ul.contributions__list',
        'ul[class*="contribution"]',
        'div:has(ul[class*="contribution"])', // not supported in old chromium but left as hint
      ];

      // Simple robust fallback: locate any UL with LI text that looks like a currency symbol inside
      let list = null;
      // first try direct class-based selection
      const direct = document.querySelector('ul.contributions__ul, ul.contributions__list, ul[class*="contribution"]');
      if (direct) list = direct;

      if (!list) {
        // Find any ul whose li contains euro symbol or "€"
        const uls = Array.from(document.querySelectorAll('ul'));
        for (const u of uls) {
          const li = u.querySelector('li');
          if (!li) continue;
          if (/\€/.test(u.innerText) || /eur/i.test(u.innerText)) {
            list = u;
            break;
          }
        }
      }

      if (!list) {
        // last resort: global search for li elements that contain € and a name-looking prefix
        const candidates = Array.from(document.querySelectorAll('li'));
        const rows = candidates.filter(li => /\€/.test(li.innerText));
        return { items: rows.map(r => r.innerText.slice(0, 500)) };
      }

      const rows = Array.from(list.querySelectorAll('li'));
      const items = rows.map(row => {
        // name heuristics
        const nameEl = row.querySelector('.contribution__name') || row.querySelector('[class*="name"]') || row.querySelector('strong, b') || row.querySelector('span');
        const amtEl = row.querySelector('.contribution__amount') || row.querySelector('[class*="amount"]') || Array.from(row.querySelectorAll('span, strong')).reverse().find(el => /[\d€,.]/.test(el.textContent));
        const name = nameEl ? nameEl.textContent.trim() : (row.textContent.split('\n')[0] || row.textContent).trim();
        const amount_label = amtEl ? amtEl.textContent.trim() : (row.textContent.match(/[\d\.,\s€]+/) || [''])[0].trim();
        return { name, amount_label };
      }).filter(x => x.name);

      return { items };
    });

    console.log('[extracted count]', extracted.items ? extracted.items.length : 0);

    // close browser
    try { await browser.close(); } catch (e) {}

    const filtered = (extracted.items || []).map(i => ({
      name: i.name,
      amount_label: i.amount_label || ''
    })).filter(c => c.name && !/^(anonyme|anonymous)$/i.test(c.name));

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({
      total_contributions_count: filtered.length,
      contributors: filtered,
      debugScripts: debug.scripts.slice(0, 10),
    });
  } catch (error) {
    try { if (browser) await browser.close(); } catch (_) {}
    console.error('error', error && error.stack ? error.stack : error);
    res.status(500).json({ error: error && error.message ? error.message : String(error) });
  }
};
