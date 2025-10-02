// /api/scrape-2wheels.js
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

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

    // Collect JSON responses so we can scan for contributions
    const jsonResponses = [];
    page.on('response', async (resp) => {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('application/json')) {
          // clone-to-json: some servers disallow double reading; swallow errors
          const data = await resp.json().catch(() => null);
          if (data) jsonResponses.push({ url: resp.url(), data });
        }
      } catch (_) {}
    });

    // Best-effort: reduce cookie banners blocking clicks
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    // Try to click any obvious cookie-accept buttons (non-fatal if not found)
    try {
      const cookieSelectors = [
        '#onetrust-accept-btn-handler',
        'button[aria-label*="Accepter"]',
        'button:has-text("Accepter")',
        'button:has-text("J’accepte")',
        '[class*="cookie"] button',
      ];
      for (const sel of cookieSelectors) {
        const btn = await page.$(sel);
        if (btn) { await btn.click().catch(() => {}); break; }
      }
    } catch {}

    // Give the SPA a moment to fetch and render
    await page.waitFor(2500);

    // ---------- Strategy A: find contributions in captured JSON ----------
    const isValidContribItem = (x) => {
      if (!x || typeof x !== 'object') return false;
      const name = (x.name || x.donorName || x.contributorName || x.contributor || '').toString().trim();
      const hasAmount = ['amountFormatted', 'amount_label', 'amount', 'value']
        .some((k) => x[k] != null && String(x[k]).trim() !== '');
      return !!name && hasAmount;
    };

    const flattenArrays = (obj) => {
      // find arrays nested under common keys
      const candidates = [];
      if (Array.isArray(obj)) candidates.push(obj);
      if (obj && typeof obj === 'object') {
        const keys = ['items', 'results', 'data', 'contributions', 'list', 'rows'];
        keys.forEach((k) => { if (Array.isArray(obj[k])) candidates.push(obj[k]); });
        // also scan all object values shallowly
        Object.values(obj).forEach((v) => {
          if (Array.isArray(v)) candidates.push(v);
          else if (v && typeof v === 'object') {
            keys.forEach((k) => { if (Array.isArray(v[k])) candidates.push(v[k]); });
          }
        });
      }
      return candidates;
    };

    let contributors = [];
    let totalCount = null;

    for (const { data } of jsonResponses) {
      const arrays = flattenArrays(data);
      for (const arr of arrays) {
        const valid = arr.filter(isValidContribItem);
        if (valid.length) {
          contributors = valid.map((x) => ({
            name: (x.name || x.donorName || x.contributorName || x.contributor || '').toString().trim(),
            amount_label: (x.amountFormatted || x.amount_label || x.amount || x.value || '').toString().trim(),
          }));
          totalCount =
            data.total || data.count || data.totalCount || data.contributionsCount || contributors.length;
          break;
        }
      }
      if (contributors.length) break;
    }

    // ---------- Strategy B: DOM scrape the visible block as a fallback ----------
    if (!contributors.length) {
      // Nudge lazy content
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          let y = 0; const step = 600;
          const id = setInterval(() => {
            window.scrollBy(0, step); y += step;
            if (y > document.body.scrollHeight * 1.2) { clearInterval(id); resolve(); }
          }, 120);
        });
      });

      // Try to locate a "Contributions" or "Dernières contributions" section
      const domData = await page.evaluate(() => {
        const sectionCandidates = [
          // explicit data-testids if present
          '[data-testid="contributions-section"]',
          // headings that might label the list
          'section:has(h2:matches(Contributions|Dernières contributions|Last contributions))',
          'div:has(h2:matches(Contributions|Dernières contributions|Last contributions))',
          // any UL with contribution-like LIs
          'ul[class*="contribution"]',
          'ul[class*="contributions"]',
        ];

        const findFirst = (sels) => {
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (el) return el;
          }
          return null;
        };

        // Polyfill :matches for querySelectorAll via filter
        const matchHeading = (el) => {
          const txt = (el.textContent || '').toLowerCase();
          return /contribution/.test(txt) || /derni[èe]res?\s+contribution/.test(txt) || /last\s+contribution/.test(txt);
        };

        let container = findFirst(sectionCandidates);
        if (!container) {
          // heuristic: find a heading and take nearest list
          const headings = Array.from(document.querySelectorAll('h2, h3, h4')).filter(matchHeading);
          if (headings.length) {
            container = headings[0].closest('section') || headings[0].parentElement || headings[0];
          }
        }
        if (!container) container = document;

        const rows = Array.from(
          container.querySelectorAll('li[class*="contribution"], li.contribution, li:has([class*="contribution__"])')
        );

        const items = rows.map((row) => {
          const nameEl =
            row.querySelector('.contribution__name') ||
            row.querySelector('[data-testid="contributor-name"]') ||
            row.querySelector('[class*="name"]');
          const amtEl =
            row.querySelector('.contribution__amount') ||
            row.querySelector('[data-testid="contribution-amount"]') ||
            row.querySelector('[class*="amount"]') ||
            row.querySelector(':scope *:matches(€|eur|euro)');
          const name = nameEl ? nameEl.textContent.trim() : '';
          const amount_label = amtEl ? amtEl.textContent.trim() : '';
          return { name, amount_label };
        }).filter(x => x.name);

        // count, if present somewhere nearby
        let total = null;
        const countEl =
          container.querySelector('[data-testid="contributions-count"]') ||
          container.querySelector('strong.bold.color--prim') ||
          document.querySelector('[data-testid="contributions-count"]');
        if (countEl && /\d/.test(countEl.textContent)) {
          total = parseInt(countEl.textContent.replace(/\D+/g, ''), 10);
        }

        return { items, total };
      });

      contributors = (domData.items || []).map(x => ({
        name: x.name,
        amount_label: x.amount_label || 'N/A',
      }));
      totalCount = domData.total != null ? domData.total : (contributors.length || null);
    }

    // ---------- Normalize & clean ----------
    const parseAmount = (label) => {
      if (!label) return null;
      const cleaned = label.replace(/[^\d,.\-]/g, '').replace(/\s/g, '');
      if (!cleaned) return null;
      const lastComma = cleaned.lastIndexOf(',');
      const lastDot = cleaned.lastIndexOf('.');
      let normalized = cleaned;
      if (lastComma > lastDot) {
        normalized = cleaned.replace(/\./g, '').replace(',', '.'); // EU decimal
      } else {
        normalized = cleaned.replace(/,/g, ''); // US/intl decimal
      }
      const num = Number(normalized);
      return Number.isFinite(num) ? num : null;
    };

    const cleaned = contributors
      .filter(c => c.name && !/^(anonyme|anonymous)$/i.test(c.name))
      .map(c => ({ ...c, amount: parseAmount(c.amount_label) }));

    const payload = {
      total_contributions_count: totalCount != null ? totalCount : cleaned.length,
      contributors: cleaned,
      source: cleaned.length ? 'network-or-dom' : 'none',
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
    if (browser) { try { await browser.close(); } catch {} }
  }
};
