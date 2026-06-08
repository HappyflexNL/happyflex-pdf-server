const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.post('/generate', async (req, res) => {
  try {
    const { html, naam } = req.body;
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=CV_${naam}.pdf`);
    res.send(pdf);
  } catch (error) {
    console.error(error);
    res.status(500).send('Fout bij genereren PDF');
  }
});

app.listen(3000, () => console.log('PDF server draait op port 3000'));
