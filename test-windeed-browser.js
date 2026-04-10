#!/usr/bin/env node
/**
 * WinDeed Browser — Interactive test & discovery script
 *
 * Runs in HEADED mode so you can see what's happening.
 * Screenshots and HTML are saved to ./data/windeed-samples/
 *
 * Usage:
 *   node test-windeed-browser.js                    # Login + screenshot all forms
 *   node test-windeed-browser.js --search erf       # Run a WinDeed Property search
 *   node test-windeed-browser.js --search address    # Run an Address Conversion search
 *   node test-windeed-browser.js --search transfers  # Run a Transfers search
 *   node test-windeed-browser.js --search deeds      # Run a Deeds Office Property search
 *   node test-windeed-browser.js --search valuation  # Run an Automated Valuation search
 *   node test-windeed-browser.js --search trust      # Run a Trust Property History search
 *   node test-windeed-browser.js --lookup "123 Main St, Gardens, Cape Town"
 */

require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const wb = require('./windeed-browser');

const SAMPLES_DIR = path.resolve(__dirname, 'data', 'windeed-samples');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Override to run headed
async function getHeadedBrowser() {
  const sessionDir = path.resolve(__dirname, 'data', 'windeed-session');
  ensureDir(sessionDir);
  return puppeteer.launch({
    headless: false,
    userDataDir: sessionDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
    defaultViewport: { width: 1280, height: 900 },
  });
}

async function discoverForms() {
  console.log('=== DISCOVERY MODE ===');
  console.log('Logging in and screenshotting all search forms...\n');

  const browser = await getHeadedBrowser();
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
  page.setDefaultTimeout(30000);
  ensureDir(SAMPLES_DIR);

  // Login
  await page.goto('https://beta.windeed.co.za', { waitUntil: 'networkidle2' });
  await sleep(2000);
  await screenshot(page, 'landing');

  const bodyText = await page.evaluate(() => document.body.innerText);
  if (!bodyText.includes('Search Menu')) {
    console.log('Not logged in — attempting login...');
    // Save the login page for inspection
    await saveHTML(page, 'login-page');
    await screenshot(page, 'login-page');
    console.log('\nLogin page saved. Check data/windeed-samples/');
    console.log('If auto-login fails, log in manually in the browser window.');
    console.log('Press Ctrl+C when done exploring.\n');
    // Keep browser open for manual interaction
    await sleep(300000);
    await browser.close();
    return;
  }

  console.log('Logged in. Discovering forms...\n');

  // Screenshot each search form
  const forms = [
    ['Property', 'Deeds Office Property'],
    ['Property', 'WinDeed Property'],
    ['Property', 'Automated Valuation'],
    ['Property', 'Transfers'],
    ['Property', 'Address Conversion'],
    ['Property', 'Trust Property History'],
  ];

  for (const menuPath of forms) {
    const name = menuPath[menuPath.length - 1].toLowerCase().replace(/\s+/g, '-');
    console.log(`Navigating to: ${menuPath.join(' > ')}`);
    try {
      // Click Search Menu first
      await page.evaluate(() => {
        const links = [...document.querySelectorAll('a, span')];
        for (const el of links) {
          if (el.textContent.trim() === 'Search Menu') { el.click(); return; }
        }
      });
      await sleep(1000);

      // Navigate sidebar
      for (const item of menuPath) {
        await page.evaluate((text) => {
          const els = [...document.querySelectorAll('a, span, div, li')];
          for (const el of els) {
            if (el.textContent.trim() === text || el.innerText.trim() === text) {
              el.click();
              return true;
            }
          }
          return false;
        }, item);
        await sleep(1500);
      }

      await screenshot(page, `form-${name}`);
      await saveHTML(page, `form-${name}`);

      // Log all form elements
      const formInfo = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll('input, select, textarea')];
        return inputs.map(el => ({
          tag: el.tagName,
          type: el.type || null,
          name: el.name || null,
          id: el.id || null,
          placeholder: el.placeholder || null,
          label: el.closest('tr, .form-group, div')?.querySelector('label, td:first-child, th')?.textContent?.trim() || null,
          options: el.tagName === 'SELECT' ? [...el.options].map(o => ({ value: o.value, text: o.text })) : null,
        }));
      });

      console.log(`  Found ${formInfo.length} form elements:`);
      for (const f of formInfo) {
        const extra = f.options ? ` [${f.options.length} options]` : '';
        console.log(`    ${f.tag}${f.type ? '[' + f.type + ']' : ''} name="${f.name}" label="${f.label}"${extra}`);
      }
      console.log();
    } catch (err) {
      console.error(`  Error navigating to ${name}: ${err.message}`);
    }
  }

  console.log('\n=== DISCOVERY COMPLETE ===');
  console.log(`Screenshots and HTML saved to: ${SAMPLES_DIR}`);
  console.log('Browser will stay open for 5 minutes for manual exploration.');
  console.log('Press Ctrl+C to exit.\n');

  await sleep(300000);
  await browser.close();
}

async function testSearch(type) {
  console.log(`=== TEST SEARCH: ${type} ===\n`);

  // Override the browser to use headed mode
  const browser = await getHeadedBrowser();
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
  page.setDefaultTimeout(30000);

  // Login
  await page.goto('https://beta.windeed.co.za', { waitUntil: 'networkidle2' });
  await sleep(2000);

  const bodyText = await page.evaluate(() => document.body.innerText);
  if (!bodyText.includes('Search Menu')) {
    console.log('Not logged in. Please log in manually in the browser.');
    console.log('Waiting 60 seconds...');
    await sleep(60000);
  }

  let result;
  switch (type) {
    case 'erf':
      console.log('Searching WinDeed Property (you may need to adjust params)...');
      // Example: search for a known ERF in Cape Town
      result = await runOnPage(page, async () => {
        return wb.searchWinDeedProperty({
          propertyType: 'Erf',
          deedsOffice: 'Cape Town',
          // township and erfNumber would come from your data
        });
      });
      break;

    case 'address':
      console.log('Searching Address Conversion...');
      result = await runOnPage(page, async () => {
        return wb.searchAddressConversion({ Address: '10 Main Road, Gardens, Cape Town' });
      });
      break;

    case 'transfers':
      console.log('Searching Transfers...');
      result = await runOnPage(page, async () => {
        return wb.searchTransfers({
          deedsOffice: 'Cape Town',
          searchBy: 'Capture Date',
          periodType: 'Date Range',
        });
      });
      break;

    case 'deeds':
      console.log('Searching Deeds Office Property...');
      result = await runOnPage(page, async () => {
        return wb.searchDeedsOfficeProperty({ deedsOffice: 'Cape Town' });
      });
      break;

    case 'valuation':
      result = await runOnPage(page, async () => {
        return wb.searchAutomatedValuation({});
      });
      break;

    case 'trust':
      result = await runOnPage(page, async () => {
        return wb.searchTrustPropertyHistory({});
      });
      break;

    default:
      console.log(`Unknown search type: ${type}`);
      console.log('Valid types: erf, address, transfers, deeds, valuation, trust');
  }

  if (result) {
    console.log('\n=== RESULTS ===');
    console.log('Key-value pairs:', JSON.stringify(result.kvPairs, null, 2));
    console.log('Table data:', JSON.stringify(result.tableData?.slice(0, 5), null, 2));
    console.log('Download links:', JSON.stringify(result.downloadLinks, null, 2));
    console.log(`Body text preview: ${result.bodyText?.substring(0, 500)}`);
  }

  console.log('\nBrowser stays open for 5 minutes. Press Ctrl+C to exit.');
  await sleep(300000);
  await browser.close();
}

async function testLookup(address) {
  console.log(`=== FULL LOOKUP: "${address}" ===\n`);
  console.log('This will run the full pipeline: Address Conversion > WinDeed Property > Transfers\n');

  const result = await wb.lookupAddress(address);

  if (result) {
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('\nNo result returned. Check data/windeed-samples/ for screenshots.');
  }

  await wb.closeBrowser();
}

// Helpers
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function screenshot(page, name) {
  ensureDir(SAMPLES_DIR);
  const file = path.join(SAMPLES_DIR, `${name}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  Screenshot: ${file}`);
}

async function saveHTML(page, name) {
  ensureDir(SAMPLES_DIR);
  const html = await page.content();
  const file = path.join(SAMPLES_DIR, `${name}-${Date.now()}.html`);
  fs.writeFileSync(file, html);
}

async function runOnPage(page, fn) {
  // The wb functions use their own page — for test mode we just call them directly
  // since they manage their own browser instance
  return fn();
}

// ─── CLI ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (!process.env.WINDEED_USERNAME || !process.env.WINDEED_PASSWORD) {
    console.log('Set WINDEED_USERNAME and WINDEED_PASSWORD in .env first');
    process.exit(1);
  }

  const searchIdx = args.indexOf('--search');
  const lookupIdx = args.indexOf('--lookup');

  if (lookupIdx >= 0) {
    const address = args[lookupIdx + 1];
    if (!address) { console.log('Usage: --lookup "address"'); process.exit(1); }
    await testLookup(address);
  } else if (searchIdx >= 0) {
    const type = args[searchIdx + 1] || 'erf';
    await testSearch(type);
  } else {
    await discoverForms();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
