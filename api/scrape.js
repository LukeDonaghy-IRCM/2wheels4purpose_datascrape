const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

// simple wait helper
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

    // collect JSON responses
    const jsonResponses = [];
    page.on('response', async (resp) => {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('application/json')) {
          const data = await resp.json().catch(() => null);
          if (data) jsonResponses.push({ url: resp.url(), data });
        }
      } catch (_) {}
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    // cookie banner (best-effort)
    try {
      const btn = await page.$('#onetrust-accept-btn-handler');
      if (btn) await btn.click().catch(() => {});
    } catch {}

    // give SPA time to render/fetch
    await sleep(3000);

    // ---------- Strategy A: parse JSON payload ----------
    let contributors = [];
    let totalCount = null;

    const isValid = (x) => {
      if (!x || typeof x !== 'object') return false;
      const name = (x.name || x.donorName || x.contributorName || x.contributor || '').toString().trim();
      const amt = x.amountFormatted || x.amount_label || x.amount || x.value;
      return name && amt;
    };

    const extractArray = (obj) => {
      if (Array.isArray(obj)) return obj;
      if (!obj || typeof obj !== 'object') return [];
      const keys = ['items', 'results', 'data', 'contributions', 'list', 'rows'];
      for (const k of keys) {
        if (Array.isArray(obj[k])) return obj[k];
      }
      return [];
    };

    for (const { data } of jsonResponses) {
      const arr = extractArray(data);
      if (arr.length && arr.some(isValid)) {
        contributors = arr
          .filter(isValid)
          .map((x) => ({
            name: (x.name || x.donorName || x.contributorName || x.contributor || '').toString().trim(),
            amount_label: (x.amountFormatted || x.amount_label || x.amount || x.value || '').toString().trim(),
          }));
        totalCount =
          data.total || data.count || data.totalCount || data.contributionsCount || contributors.length;
        break;
      }
    }

    // ---------- Strategy B: DOM scrape ----------
    if (!contributors.length) {
      const domData = await page.evaluate(() => {
        const headings = Array.from(document.querySelectorAll('h2, h3, h4'));
        let container = null;
        for (const h of headings) {
          const txt = (h.textContent || '').toLowerCase();
          if (txt.includes('contribution')) {
            container = h.closest('section') || h.parentElement;
            break;
          }
        }
        if (!container) container = document;

        const rows = Array.from(
          container.querySelectorAll('li.contribution, li[class*="contribution"]')
        );

        const items = rows.map((row) => {
          const nameEl =
            row.querySelector('.contribution__name') ||
            row.querySelector('[class*="name"]');
          const amtEl =
            row.querySelector('.contribution__amount') ||
            row.querySelector('[class*="amount"]');
          return {
            name: nameEl ? nameEl.textContent.trim() : '',
            amount_label: amtEl ? amtEl.textContent.trim() : '',
          };
        }).filter(x => x.name);

        let total = null;
        const countEl = document.querySelector('[data-testid="contributions-count"]');
        if (countEl && /\d/.test(countEl.textContent)) {
          total = parseInt(countEl.textContent.replace(/\D+/g, ''), 10);
        }

        return { items, total };
      });

      contributors = domData.items || [];
      totalCount = domData.total != null ? domData.total : contributors.length;
    }

    // ---------- Normalize ----------
    const parseAmount = (label) => {
      if (!label) return null;
      const cleaned = label.replace(/[^\d,.,-]/g, '').replace(/\s/g, '');
      if (!cleaned) return null;
      const lastComma = cleaned.lastIndexOf(',');
      const lastDot = cleaned.lastIndexOf('.');
      let normalized = cleaned;
      if (lastComma > lastDot) {
        normalized = cleaned.replace(/\./g, '').replace(',', '.');
      } else {
        normalized = cleaned.replace(/,/g, '');
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
      try { await browser.close(); } catch {}
    }
  }
};
