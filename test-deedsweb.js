#!/usr/bin/env node
/**
 * DeedsWeb — Interactive test & discovery script
 *
 * Runs in HEADED mode so you can see the government portal.
 * Screenshots and HTML saved to ./data/deedsweb-samples/
 *
 * Usage:
 *   node test-deedsweb.js                          # Login + screenshot all forms
 *   node test-deedsweb.js --search property        # Property Enquiry
 *   node test-deedsweb.js --search person           # Person Enquiry
 *   node test-deedsweb.js --search deed             # Title Deed Enquiry
 *   node test-deedsweb.js --search transfers        # Transfers Enquiry
 *   node test-deedsweb.js --lookup "10 Main Rd, Gardens, Cape Town"
 */

require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const deedsweb = require('./deedsweb');

const SAMPLES_DIR = path.resolve(__dirname, 'data', 'deedsweb-samples');
const SESSION_DIR = path.resolve(__dirname, 'data', 'deedsweb-session');
const DEEDSWEB_URL = 'https://deedsweb.deeds.gov.za/deedsweb';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

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
  console.log(`  HTML: ${file}`);
}

async function getHeadedBrowser() {
  ensureDir(SESSION_DIR);
  return puppeteer.launch({
    headless: false,
    userDataDir: SESSION_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
    defaultViewport: { width: 1280, height: 900 },
  });
}

// ─── Discovery mode ───────────────────────────────────────────────────

async function discover() {
  console.log('=== DEEDSWEB DISCOVERY MODE ===\n');

  const browser = await getHeadedBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  // Go to login page
  console.log('Loading login page...');
  await page.goto(`${DEEDSWEB_URL}/logon.jsp`, { waitUntil: 'networkidle2' });
  await sleep(2000);
  await screenshot(page, 'login-page');
  await saveHTML(page, 'login-page');

  // Log all form elements on login page
  const loginFormInfo = await page.evaluate(() => {
    return [...document.querySelectorAll('input, select, button')].map(el => ({
      tag: el.tagName, type: el.type, name: el.name, id: el.id, value: el.value,
      placeholder: el.placeholder,
    }));
  });
  console.log('\nLogin form elements:');
  loginFormInfo.forEach(f => console.log(`  ${f.tag}[${f.type}] name="${f.name}" id="${f.id}"`));

  // Try to log in
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.includes('Enquiry') || bodyText.includes('Search')) {
    console.log('\nAlready logged in!');
  } else if (process.env.DEEDSWEB_USERNAME && process.env.DEEDSWEB_PASSWORD) {
    console.log('\nAttempting login...');
    try {
      // Find and fill username
      const inputs = await page.$$('input');
      for (const input of inputs) {
        const type = await input.evaluate(el => el.type);
        const name = await input.evaluate(el => el.name);
        if (type === 'text' || type === '' || name.toLowerCase().includes('user')) {
          await input.click({ clickCount: 3 });
          await input.type(process.env.DEEDSWEB_USERNAME, { delay: 30 });
          console.log(`  Filled username in: ${name || type}`);
          break;
        }
      }
      for (const input of inputs) {
        const type = await input.evaluate(el => el.type);
        if (type === 'password') {
          await input.click({ clickCount: 3 });
          await input.type(process.env.DEEDSWEB_PASSWORD, { delay: 30 });
          console.log('  Filled password');
          break;
        }
      }

      // Submit
      const submitBtn = await page.$('input[type="submit"], button[type="submit"]');
      if (submitBtn) {
        const val = await submitBtn.evaluate(el => el.value || el.textContent);
        console.log(`  Clicking submit: "${val}"`);
        await submitBtn.click();
      } else {
        console.log('  No submit button found — pressing Enter');
        await page.keyboard.press('Enter');
      }

      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await sleep(3000);
      await screenshot(page, 'post-login');
      await saveHTML(page, 'post-login');

      const postLogin = await page.evaluate(() => document.body.innerText);
      if (postLogin.includes('Enquiry') || postLogin.includes('Property')) {
        console.log('  Login successful!');
      } else {
        console.log('  Login may have failed — check screenshot');
      }
    } catch (err) {
      console.log(`  Login error: ${err.message}`);
    }
  } else {
    console.log('\nNo credentials set. Log in manually in the browser window.');
    console.log('Waiting 60 seconds...');
    await sleep(60000);
  }

  // Screenshot the main page after login
  await screenshot(page, 'main-page');
  await saveHTML(page, 'main-page');

  // Log all visible links
  const links = await page.evaluate(() => {
    return [...document.querySelectorAll('a')].map(a => ({
      text: a.textContent.trim(),
      href: a.href,
    })).filter(l => l.text.length > 0 && l.text.length < 100);
  });
  console.log('\nAll links on page:');
  links.forEach(l => console.log(`  [${l.text}] → ${l.href}`));

  // Try to navigate to each enquiry type and screenshot
  const enquiryTypes = ['Property Enquiry', 'Person Enquiry', 'Title Deed', 'Transfer'];
  for (const enquiry of enquiryTypes) {
    console.log(`\nNavigating to: ${enquiry}...`);
    try {
      const clicked = await page.evaluate((text) => {
        const els = [...document.querySelectorAll('a, td, span')];
        for (const el of els) {
          if (el.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
            el.click();
            return true;
          }
        }
        return false;
      }, enquiry);

      if (clicked) {
        await sleep(3000);
        const name = enquiry.toLowerCase().replace(/\s+/g, '-');
        await screenshot(page, `form-${name}`);
        await saveHTML(page, `form-${name}`);

        // Log form elements
        const formInfo = await page.evaluate(() => {
          return [...document.querySelectorAll('input, select, textarea')].map(el => ({
            tag: el.tagName, type: el.type || '', name: el.name, id: el.id,
            label: el.closest('tr')?.querySelector('td:first-child')?.textContent?.trim() || '',
            options: el.tagName === 'SELECT' ? [...el.options].slice(0, 10).map(o => o.text) : null,
          }));
        });
        console.log(`  Form elements for ${enquiry}:`);
        formInfo.forEach(f => {
          const extra = f.options ? ` [${f.options.join(', ')}]` : '';
          console.log(`    ${f.tag}[${f.type}] name="${f.name}" label="${f.label}"${extra}`);
        });
      } else {
        console.log(`  Could not find "${enquiry}" link`);
      }
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
  }

  console.log('\n=== DISCOVERY COMPLETE ===');
  console.log(`Screenshots and HTML saved to: ${SAMPLES_DIR}`);
  console.log('Browser stays open for 5 minutes. Press Ctrl+C to exit.\n');
  await sleep(300000);
  await browser.close();
}

// ─── Test search ──────────────────────────────────────────────────────

async function testSearch(type) {
  console.log(`=== TEST SEARCH: ${type} ===\n`);

  let result;
  switch (type) {
    case 'property':
      result = await deedsweb.searchProperty({
        propertyType: 'ERF',
        township: 'Gardens',
        deedsOffice: 'Cape Town',
      });
      break;
    case 'person':
      result = await deedsweb.searchPerson({
        surname: 'Smith',
        deedsOffice: 'Cape Town',
      });
      break;
    case 'deed':
      result = await deedsweb.searchTitleDeed({
        deedsOffice: 'Cape Town',
      });
      break;
    case 'transfers':
      result = await deedsweb.searchTransfers({
        township: 'Gardens',
        deedsOffice: 'Cape Town',
      });
      break;
    default:
      console.log(`Unknown type: ${type}. Use: property, person, deed, transfers`);
      return;
  }

  if (result) {
    console.log('\n=== RESULTS ===');
    console.log('KV pairs:', JSON.stringify(result.kvPairs, null, 2));
    console.log('Tables:', result.tables?.length || 0);
    result.tables?.forEach((t, i) => {
      console.log(`  Table ${i}: ${t.headers.join(' | ')}`);
      t.rows.slice(0, 3).forEach(r => console.log(`    ${JSON.stringify(r)}`));
    });
    console.log('Detail links:', result.detailLinks?.length || 0);
  } else {
    console.log('No results.');
  }

  await deedsweb.closeBrowser();
}

// ─── Test full lookup ─────────────────────────────────────────────────

async function testLookup(address) {
  console.log(`=== FULL LOOKUP: "${address}" ===\n`);

  const result = await deedsweb.lookupAddress(address);

  if (result) {
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('No result. Check data/deedsweb-samples/ for screenshots.');
  }

  await deedsweb.closeBrowser();
}

// ─── CLI ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const searchIdx = args.indexOf('--search');
  const lookupIdx = args.indexOf('--lookup');

  if (lookupIdx >= 0) {
    if (!process.env.DEEDSWEB_USERNAME) { console.log('Set DEEDSWEB_USERNAME + DEEDSWEB_PASSWORD in .env'); process.exit(1); }
    await testLookup(args[lookupIdx + 1]);
  } else if (searchIdx >= 0) {
    if (!process.env.DEEDSWEB_USERNAME) { console.log('Set DEEDSWEB_USERNAME + DEEDSWEB_PASSWORD in .env'); process.exit(1); }
    await testSearch(args[searchIdx + 1] || 'property');
  } else {
    await discover();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
