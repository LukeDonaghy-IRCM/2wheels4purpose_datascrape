const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  const targetUrl =
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
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    // Scroll to trigger lazy rendering
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
        }, 150);
      });
    });

    await sleep(3000);

    // --- Extract contributors from DOM ---
    const extracted = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll('li.contribution, li[class*="contribution"]')
      );

      const contributors = rows.map((row) => {
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
      }).filter(c => c.name);

      let total = null;
      const countEl = document.querySelector('[data-testid="contributions-count"]') ||
                      document.querySelector('strong.bold.color--prim');
      if (countEl && /\d/.test(countEl.textContent)) {
        total = parseInt(countEl.textContent.replace(/\D+/g, ''), 10);
      }

      return { contributors, total };
    });

    await browser.close();

    // Filter out anonymous
    const filtered = extracted.contributors.filter(
      (c) => !/^(anonyme|anonymous)$/i.test(c.name)
    );

    res.status(200).json({
      total_contributions_count:
        extracted.total != null ? extracted.total : filtered.length,
      contributors: filtered,
    });
  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};
