// /api/scrape-2wheels.js
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

module.exports = async (req, res) => {
  const urlToScrape =
    'https://jesoutiens.fondationsaintluc.be/fr-FR/project/2-wheels-4-purpose';

  let browser = null;

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

    // Helpful on some SPA/CDN setups
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Go to page; let initial resources load
    await page.goto(urlToScrape, { waitUntil: 'networkidle2', timeout: 45000 });

    // ---- STRATEGY A: wait for DOM to render and scrape ----
    // Try a few plausible selectors; the original code used a class list without dots and never awaited it.
    // We try multiple in case the site’s CSS classes vary by build.
    const listSelectors = [
      'ul.contributions__ul',               // common BEM-ish list class
      'ul.contributions__list',
      'ul[class*="contributions__"]',
      'section[id*="contributions"] ul',    // fallback: section + ul
    ];

    // Wait for any one of these to appear (up to 20s)
    let foundSelector = null;
    for (const sel of listSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 20000 });
        foundSelector = sel;
        break;
      } catch (_) { /* keep trying */ }
    }

    // Helper to parse money like "€ 25,00" or "€25.00"
    function parseAmount(text) {
      if (!text) return null;
      const cleaned = text
        .replace(/[^\d,.\-]/g, '')     // keep digits and separators
        .replace(/\s/g, '');
      // Heuristic: if there are both , and ., assume , is thousands in EU or decimal.
      // Prefer last separator as decimal.
      const lastComma = cleaned.lastIndexOf(',');
      const lastDot = cleaned.lastIndexOf('.');
      let normalized = cleaned;
      if (lastComma > lastDot) {
        // Treat comma as decimal; remove dots
        normalized = cleaned.replace(/\./g, '').replace(',', '.');
      } else {
        // Treat dot as decimal; remove commas
        normalized = cleaned.replace(/,/g, '');
      }
      const num = Number(normalized);
      return Number.isFinite(num) ? num : null;
    }

    // Try DOM scrape first
    let extracted = await page.evaluate(
      ({ foundSelector }) => {
        // Count element: try a couple of likely spots
        const countCandidates = [
          'strong.bold.color--prim',
          'strong.color--prim',
          '[class*="donations__count"] strong',
          '[data-testid="contributions-count"]',
          'p > strong',
        ];
        let totalContributions = null;
        for (const sel of countCandidates) {
          const el = document.querySelector(sel);
          if (el && /\d/.test(el.textContent)) {
            const m = el.textContent.replace(/\D+/g, '');
            if (m) { totalContributions = parseInt(m, 10); break; }
          }
        }

        // List items
        let items = [];
        if (foundSelector) {
          const list = document.querySelector(foundSelector);
          if (list) {
            const rows = list.querySelectorAll('li[class*="contribution"]');
            rows.forEach((row) => {
              const nameEl =
                row.querySelector('.contribution__name') ||
                row.querySelector('[class*="contribution__name"]') ||
                row.querySelector('[data-testid="contributor-name"]');
              const amtEl =
                row.querySelector('.contribution__amount') ||
                row.querySelector('[class*="contribution__amount"]') ||
                row.querySelector('[data-testid="contribution-amount"]');

              const name = nameEl ? nameEl.textContent.trim() : '';
              const amountText = amtEl ? amtEl.textContent.trim() : '';

              if (
                name &&
                name.toLowerCase() !== 'anonyme' &&
                name.toLowerCase() !== 'anonymous'
              ) {
                items.push({ name, amountText });
              }
            });
          }
        }

        return { totalContributions, items };
      },
      { foundSelector }
    );

    // If the DOM structure changed or didn't load in time, try a network response fallback.
    if (!extracted || (!extracted.items?.length && extracted.totalContributions == null)) {
      // ---- STRATEGY B: capture the XHR/Fetch that returns contributions ----
      // Wait for any GET to a likely "contribution(s)" endpoint
      const resp = await page.waitForResponse(
        r =>
          r.request().method() === 'GET' &&
          /contribution/i.test(r.url()) &&
          // Avoid catching CSS/images
          r.headers()['content-type'] &&
          r.headers()['content-type'].includes('application/json'),
        { timeout: 30000 }
      ).catch(() => null);

      if (resp) {
        const data = await resp.json().catch(() => null);
        if (data) {
          // Try to normalize shape. We accept arrays or objects with fields like items/list/results.
          const list =
            Array.isArray(data) ? data :
            data.items || data.results || data.data || data.contributions || [];

          const contributors = list
            .map(x => {
              // Best guesses for field names
              const name =
                x.name || x.donorName || x.contributorName || x.contributor || '';
              const amountText =
                x.amountFormatted || x.amount_label || x.amount || x.value || '';
              return { name: String(name || '').trim(), amountText: String(amountText || '').trim() };
            })
            .filter(x =>
              x.name &&
              x.name.toLowerCase() !== 'anonyme' &&
              x.name.toLowerCase() !== 'anonymous'
            );

          extracted = {
            totalContributions:
              data.total || data.count || data.totalCount || contributors.length,
            items: contributors
          };
        }
      }
    }

    // As a last resort, try a gentle scroll to trigger lazy loading & re-scrape once
    if (!extracted?.items?.length) {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          const totalHeight = document.body.scrollHeight;
          let scrolled = 0;
          const step = 600;
          const id = setInterval(() => {
            window.scrollBy(0, step);
            scrolled += step;
            if (scrolled >= totalHeight) { clearInterval(id); resolve(); }
          }, 150);
        });
      });
      // Re-try DOM read quickly
      for (const sel of listSelectors) {
        const ok = await page.$(sel);
        if (ok) { foundSelector = sel; break; }
      }
      if (foundSelector) {
        extracted = await page.evaluate(({ foundSelector }) => {
          const rows = Array.from(
            document.querySelectorAll(`${foundSelector} li[class*="contribution"]`)
          );
          const items = rows.map(row => {
            const name =
              (row.querySelector('.contribution__name') ||
               row.querySelector('[class*="contribution__name"]') ||
               row.querySelector('[data-testid="contributor-name"]') ||
               { textContent: '' }).textContent.trim();
            const amountText =
              (row.querySelector('.contribution__amount') ||
               row.querySelector('[class*="contribution__amount"]') ||
               row.querySelector('[data-testid="contribution-amount"]') ||
               { textContent: '' }).textContent.trim();
            return { name, amountText };
          }).filter(x => x.name && !/^(anonyme|anonymous)$/i.test(x.name));
          return { totalContributions: null, items };
        }, { foundSelector });
      }
    }

    // Normalize output
    const contributors = (extracted?.items || []).map(({ name, amountText }) => ({
      name,
      amount_label: amountText || 'N/A',
      amount: parseAmount(amountText),
    }));

    const payload = {
      total_contributions_count:
        extracted?.totalContributions != null
          ? extracted.totalContributions
          : contributors.length,
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
      try { await browser.close(); } catch (_) {}
    }
  }
};
