const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

module.exports = async (req, res) => {
  const url =
    'https://jesoutiens.fondationsaintluc.be/fr-FR/project/2-wheels-4-purpose?tab=vue-d-ensemble';

  let browser;
  try {
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    // scroll to make sure Vue renders everything
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0;
        const step = 400;
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

    // grab contributors directly from DOM
    const extracted = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll('li.contribution, li[class*="contribution"]')
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
          amount: amtEl ? amtEl.textContent.trim() : '',
        };
      }).filter(x => x.name);

      return items;
    });

    await browser.close();

    res.status(200).json({
      total_contributions_count: extracted.length,
      contributors: extracted.filter(
        c => c.name && !/^(anonyme|anonymous)$/i.test(c.name)
      ),
    });
  } catch (error) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};
