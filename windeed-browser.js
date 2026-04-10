/**
 * WinDeed Browser Automation — Puppeteer-based scraper for beta.windeed.co.za
 *
 * Automates Lexis WinDeed web interface since no API is available.
 * Uses persistent session cookies to minimise re-login.
 *
 * Credentials: WINDEED_USERNAME + WINDEED_PASSWORD in .env
 * Cost: ~R50/search (voucher-based), check balance before querying
 *
 * Drop-in replacement for windeed.js — exports lookupAddress() with same shape.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const pool = require('./db');

const WINDEED_URL = 'https://beta.windeed.co.za';
const WINDEED_USERNAME = process.env.WINDEED_USERNAME;
const WINDEED_PASSWORD = process.env.WINDEED_PASSWORD;
const SESSION_DIR = path.resolve(__dirname, 'data', 'windeed-session');
const SAMPLES_DIR = path.resolve(__dirname, 'data', 'windeed-samples');
const SCREENSHOT_ON_ERROR = true;
const DEFAULT_TIMEOUT = 30000;
const NAV_DELAY = 1500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Browser singleton ────────────────────────────────────────────────

let _browser = null;
let _page = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  ensureDir(SESSION_DIR);
  _browser = await puppeteer.launch({
    headless: true,
    userDataDir: SESSION_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--ignore-certificate-errors',
    ],
  });
  return _browser;
}

async function getPage() {
  if (_page && !_page.isClosed()) return _page;
  const browser = await getBrowser();
  _page = await browser.newPage();
  await _page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await _page.setViewport({ width: 1280, height: 900 });
  _page.setDefaultTimeout(DEFAULT_TIMEOUT);
  return _page;
}

async function closeBrowser() {
  if (_page && !_page.isClosed()) await _page.close().catch(() => {});
  if (_browser && _browser.connected) await _browser.close().catch(() => {});
  _page = null;
  _browser = null;
}

// ─── Screenshot helper ────────────────────────────────────────────────

async function screenshot(page, name) {
  ensureDir(SAMPLES_DIR);
  const file = path.join(SAMPLES_DIR, `${name}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`[windeed-browser] Screenshot: ${file}`);
  return file;
}

// ─── Login ────────────────────────────────────────────────────────────

async function ensureLoggedIn(page) {
  await page.goto(WINDEED_URL, { waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT });
  await sleep(1000);

  const url = page.url();
  const bodyText = await page.evaluate(() => document.body.innerText);

  // Check if already logged in — look for nav elements
  if (bodyText.includes('Search Menu') && bodyText.includes('Balance:')) {
    console.log('[windeed-browser] Already logged in');
    return true;
  }

  // Need to login
  if (!WINDEED_USERNAME || !WINDEED_PASSWORD) {
    throw new Error('WINDEED_USERNAME and WINDEED_PASSWORD must be set in .env');
  }

  console.log('[windeed-browser] Logging in...');

  // Try common login form selectors
  const usernameSelectors = [
    'input[name="username"]', 'input[name="email"]', 'input[name="Username"]',
    'input[name="Email"]', 'input[type="email"]', '#username', '#email',
    'input[placeholder*="mail"]', 'input[placeholder*="user"]',
  ];
  const passwordSelectors = [
    'input[name="password"]', 'input[name="Password"]',
    'input[type="password"]', '#password',
  ];

  let usernameInput = null;
  for (const sel of usernameSelectors) {
    usernameInput = await page.$(sel);
    if (usernameInput) break;
  }

  let passwordInput = null;
  for (const sel of passwordSelectors) {
    passwordInput = await page.$(sel);
    if (passwordInput) break;
  }

  if (!usernameInput || !passwordInput) {
    await screenshot(page, 'login-form-not-found');
    // Save HTML for debugging
    const html = await page.content();
    const htmlFile = path.join(SAMPLES_DIR, `login-page-${Date.now()}.html`);
    fs.writeFileSync(htmlFile, html);
    throw new Error(`Login form not found. Screenshot and HTML saved to ${SAMPLES_DIR}`);
  }

  await usernameInput.click({ clickCount: 3 });
  await usernameInput.type(WINDEED_USERNAME, { delay: 50 });
  await passwordInput.click({ clickCount: 3 });
  await passwordInput.type(WINDEED_PASSWORD, { delay: 50 });

  // Submit — try button, then Enter
  const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign In")');
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await passwordInput.press('Enter');
  }

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT }).catch(() => {});
  await sleep(2000);

  const postLoginText = await page.evaluate(() => document.body.innerText);
  if (postLoginText.includes('Search Menu') || postLoginText.includes('Balance:')) {
    console.log('[windeed-browser] Login successful');
    return true;
  }

  await screenshot(page, 'login-failed');
  throw new Error('Login appears to have failed — no "Search Menu" found after submit');
}

// ─── Balance check ────────────────────────────────────────────────────

async function getBalance(page) {
  const text = await page.evaluate(() => document.body.innerText);
  const match = text.match(/Balance:\s*R\s*([\d,.]+)/i);
  if (match) {
    return parseFloat(match[1].replace(/,/g, ''));
  }
  return null;
}

// ─── Sidebar navigation ──────────────────────────────────────────────

async function navigateToSearch(page, menuPath) {
  // menuPath is an array like ['Property', 'WinDeed Property']
  // First ensure we're on the search menu
  const searchMenuLink = await page.$('a[href*="Search"], a:has-text("Search Menu")');
  if (searchMenuLink) {
    await searchMenuLink.click();
    await sleep(NAV_DELAY);
  }

  for (const item of menuPath) {
    // Click the sidebar item — try multiple strategies
    const clicked = await page.evaluate((text) => {
      const links = [...document.querySelectorAll('a, span, div, li')];
      for (const el of links) {
        if (el.textContent.trim() === text || el.innerText.trim() === text) {
          el.click();
          return true;
        }
      }
      return false;
    }, item);

    if (!clicked) {
      // Try XPath as fallback
      const [el] = await page.$$(`xpath/.//a[contains(text(),"${item}")] | .//span[contains(text(),"${item}")] | .//div[contains(text(),"${item}")]`);
      if (el) {
        await el.click();
      } else {
        throw new Error(`Could not find sidebar item: "${item}"`);
      }
    }
    await sleep(NAV_DELAY);
  }
}

// ─── Form helpers ─────────────────────────────────────────────────────

async function selectDropdown(page, labelText, value) {
  if (!value) return;
  // Find the select element near the label
  const selected = await page.evaluate((label, val) => {
    const labels = [...document.querySelectorAll('label, td, th, div, span')];
    for (const lbl of labels) {
      if (lbl.textContent.trim().includes(label)) {
        // Look for a select near this label
        const parent = lbl.closest('tr, div, fieldset, .form-group') || lbl.parentElement;
        const select = parent?.querySelector('select');
        if (select) {
          const options = [...select.options];
          for (const opt of options) {
            if (opt.text.toLowerCase().includes(val.toLowerCase()) ||
                opt.value.toLowerCase().includes(val.toLowerCase())) {
              select.value = opt.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
        }
      }
    }
    return false;
  }, labelText, value);
  if (!selected) {
    console.warn(`[windeed-browser] Could not select "${value}" for "${labelText}"`);
  }
  await sleep(500);
}

async function fillField(page, labelText, value) {
  if (!value) return;
  const filled = await page.evaluate((label, val) => {
    const labels = [...document.querySelectorAll('label, td, th, div, span')];
    for (const lbl of labels) {
      if (lbl.textContent.trim().includes(label)) {
        const parent = lbl.closest('tr, div, fieldset, .form-group') || lbl.parentElement;
        const input = parent?.querySelector('input[type="text"], input:not([type]), textarea');
        if (input) {
          input.value = val;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
    }
    return false;
  }, labelText, value);
  if (!filled) {
    console.warn(`[windeed-browser] Could not fill "${value}" for "${labelText}"`);
  }
  await sleep(300);
}

async function clickSearch(page) {
  const clicked = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, input[type="submit"], a.btn')];
    for (const btn of buttons) {
      const text = btn.textContent.trim().toLowerCase();
      if (text.includes('search') && !text.includes('menu')) {
        btn.click();
        return true;
      }
    }
    return false;
  });
  if (!clicked) {
    throw new Error('Could not find Search button');
  }
  // Wait for navigation or results to load
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT }).catch(() => {}),
    sleep(5000),
  ]);
  await sleep(2000);
}

// ─── Results extraction ───────────────────────────────────────────────

async function extractResults(page, searchType) {
  ensureDir(SAMPLES_DIR);

  // Screenshot the results
  await screenshot(page, `results-${searchType}`);

  // Save raw HTML
  const html = await page.content();
  const htmlFile = path.join(SAMPLES_DIR, `results-${searchType}-${Date.now()}.html`);
  fs.writeFileSync(htmlFile, html);

  const bodyText = await page.evaluate(() => document.body.innerText);

  // Check for error messages
  if (bodyText.includes('No results') || bodyText.includes('no records') ||
      bodyText.includes('No data') || bodyText.includes('0 results')) {
    console.log(`[windeed-browser] No results for ${searchType}`);
    return null;
  }

  // Check for insufficient balance
  if (bodyText.includes('insufficient') || bodyText.includes('Insufficient') ||
      bodyText.includes('balance') && bodyText.includes('low')) {
    throw new Error('Insufficient WinDeed balance — top up vouchers at beta.windeed.co.za');
  }

  // Try to extract table data
  const tableData = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const results = [];
    for (const table of tables) {
      const headers = [...table.querySelectorAll('th')].map(th => th.textContent.trim());
      const rows = [...table.querySelectorAll('tbody tr, tr:not(:first-child)')];
      for (const row of rows) {
        const cells = [...row.querySelectorAll('td')].map(td => td.textContent.trim());
        if (cells.length > 0) {
          const obj = {};
          cells.forEach((cell, i) => {
            const key = headers[i] || `col_${i}`;
            obj[key] = cell;
          });
          results.push(obj);
        }
      }
    }
    return results;
  });

  // Try to extract key-value pairs (common in detail views)
  const kvPairs = await page.evaluate(() => {
    const pairs = {};
    // Look for label: value patterns in the page
    const rows = document.querySelectorAll('tr, .row, .form-group, dl dt');
    for (const row of rows) {
      const label = row.querySelector('td:first-child, th, dt, label, .label');
      const value = row.querySelector('td:last-child, dd, .value, td:nth-child(2)');
      if (label && value && label !== value) {
        const key = label.textContent.trim().replace(/:$/, '');
        const val = value.textContent.trim();
        if (key && val && key !== val) {
          pairs[key] = val;
        }
      }
    }
    return pairs;
  });

  // Check for downloadable PDF/document links
  const downloadLinks = await page.evaluate(() => {
    const links = [];
    document.querySelectorAll('a[href*="download"], a[href*=".pdf"], button:has-text("PDF"), a:has-text("PDF"), a:has-text("Download")').forEach(el => {
      links.push({
        text: el.textContent.trim(),
        href: el.href || el.getAttribute('data-href') || null,
      });
    });
    return links;
  });

  return {
    tableData,
    kvPairs,
    downloadLinks,
    bodyText: bodyText.substring(0, 5000),
    htmlFile,
  };
}

// ─── Search: Deeds Office Property ────────────────────────────────────

async function searchDeedsOfficeProperty({ deedsOffice, propertyType, erfNumber, portionNumber, township } = {}) {
  const page = await getPage();
  await ensureLoggedIn(page);

  const balance = await getBalance(page);
  console.log(`[windeed-browser] Balance: R${balance}`);
  if (balance !== null && balance < 50) {
    console.warn('[windeed-browser] Low balance warning');
  }

  await navigateToSearch(page, ['Property', 'Deeds Office Property']);
  await sleep(1000);

  if (deedsOffice) await selectDropdown(page, 'Deeds Office', deedsOffice);
  if (propertyType) await selectDropdown(page, 'Property Type', propertyType);
  if (township) await fillField(page, 'Township', township);
  if (erfNumber) await fillField(page, 'Erf Number', erfNumber);
  if (portionNumber) await fillField(page, 'Portion', portionNumber);

  await clickSearch(page);
  return extractResults(page, 'deeds-office-property');
}

// ─── Search: WinDeed Property ─────────────────────────────────────────

async function searchWinDeedProperty({ searchBy, propertyType, deedsOffice, township, erfNumber, portionNumber, reference } = {}) {
  const page = await getPage();
  await ensureLoggedIn(page);

  const balance = await getBalance(page);
  console.log(`[windeed-browser] Balance: R${balance}`);

  await navigateToSearch(page, ['Property', 'WinDeed Property']);
  await sleep(1000);

  if (searchBy) await selectDropdown(page, 'Search By', searchBy);
  if (propertyType) await selectDropdown(page, 'Property Type', propertyType);
  if (deedsOffice) await selectDropdown(page, 'Deeds Office', deedsOffice);

  // Township has a "Find" button — may need special handling
  if (township) {
    await fillField(page, 'Township', township);
    // Click "Find" if it exists
    const findBtn = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, a.btn, input[type="button"]')];
      for (const btn of btns) {
        if (btn.textContent.trim().toLowerCase() === 'find') {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (findBtn) await sleep(2000);
  }

  if (erfNumber) await fillField(page, 'Erf Number', erfNumber);
  if (portionNumber) await fillField(page, 'Portion Number', portionNumber);
  if (reference) await fillField(page, 'Reference', reference);

  await clickSearch(page);
  return extractResults(page, 'windeed-property');
}

// ─── Search: Automated Valuation ──────────────────────────────────────

async function searchAutomatedValuation(params = {}) {
  const page = await getPage();
  await ensureLoggedIn(page);

  await navigateToSearch(page, ['Property', 'Automated Valuation']);
  await sleep(1000);

  // Screenshot the form for discovery
  await screenshot(page, 'form-automated-valuation');

  // Fill whatever fields match
  for (const [label, value] of Object.entries(params)) {
    if (value) await fillField(page, label, String(value));
  }

  await clickSearch(page);
  return extractResults(page, 'automated-valuation');
}

// ─── Search: Transfers ────────────────────────────────────────────────

async function searchTransfers({ searchBy, periodType, dateFrom, dateTo, deedsOffice, propertyTypes, minPrice, maxPrice, reference } = {}) {
  const page = await getPage();
  await ensureLoggedIn(page);

  await navigateToSearch(page, ['Property', 'Transfers']);
  await sleep(1000);

  if (searchBy) await selectDropdown(page, 'Search By', searchBy);

  // Period details — radio buttons
  if (periodType) {
    await page.evaluate((pType) => {
      const radios = document.querySelectorAll('input[type="radio"]');
      for (const radio of radios) {
        const label = radio.closest('label') || radio.parentElement;
        if (label && label.textContent.toLowerCase().includes(pType.toLowerCase())) {
          radio.click();
          return;
        }
      }
    }, periodType);
    await sleep(500);
  }

  if (dateFrom) await fillField(page, 'From', dateFrom);
  if (dateTo) await fillField(page, 'To', dateTo);
  if (deedsOffice) await selectDropdown(page, 'Deeds Office', deedsOffice);
  if (propertyTypes) await selectDropdown(page, 'Include Property Types', propertyTypes);
  if (minPrice) await selectDropdown(page, 'Min Purchase Price', minPrice);
  if (maxPrice) await selectDropdown(page, 'Max Purchase Price', maxPrice);
  if (reference) await fillField(page, 'Reference', reference);

  await clickSearch(page);
  return extractResults(page, 'transfers');
}

// ─── Search: Address Conversion ───────────────────────────────────────

async function searchAddressConversion(params = {}) {
  const page = await getPage();
  await ensureLoggedIn(page);

  await navigateToSearch(page, ['Property', 'Address Conversion']);
  await sleep(1000);

  // Screenshot the form for discovery
  await screenshot(page, 'form-address-conversion');

  // Fill whatever fields match
  for (const [label, value] of Object.entries(params)) {
    if (value) await fillField(page, label, String(value));
  }

  await clickSearch(page);
  return extractResults(page, 'address-conversion');
}

// ─── Search: Trust Property History ───────────────────────────────────

async function searchTrustPropertyHistory(params = {}) {
  const page = await getPage();
  await ensureLoggedIn(page);

  await navigateToSearch(page, ['Property', 'Trust Property History']);
  await sleep(1000);

  // Screenshot the form for discovery
  await screenshot(page, 'form-trust-property-history');

  // Fill whatever fields match
  for (const [label, value] of Object.entries(params)) {
    if (value) await fillField(page, label, String(value));
  }

  await clickSearch(page);
  return extractResults(page, 'trust-property-history');
}

// ─── Normalise results to pipeline shape ──────────────────────────────

function normaliseResults(propertyResult, transferResult) {
  if (!propertyResult) return null;

  const kv = propertyResult.kvPairs || {};
  const table = propertyResult.tableData || [];

  // Extract from key-value pairs (detail views)
  const erfNumber = kv['Erf Number'] || kv['ERF'] || kv['Erf'] || null;
  const registeredOwner = kv['Registered Owner'] || kv['Owner'] || kv['Owner Name'] || null;
  const titleDeedRef = kv['Title Deed'] || kv['Title Deed Reference'] || kv['Deed Number'] || null;
  const municipalValue = parseInt((kv['Municipal Value'] || kv['Municipal Valuation'] || '0').replace(/[^\d]/g, '')) || null;
  const lpiCode = kv['LPI Code'] || kv['LPI'] || kv['Land Parcel Identifier'] || null;
  const bondHolder = kv['Bond Holder'] || kv['Bondholder'] || null;
  const bondAmount = parseInt((kv['Bond Amount'] || kv['Bond'] || '0').replace(/[^\d]/g, '')) || null;
  const deedsOffice = kv['Deeds Office'] || null;
  const extentSqm = parseInt((kv['Extent'] || kv['Extent (m²)'] || kv['Size'] || '0').replace(/[^\d]/g, '')) || null;
  const township = kv['Township'] || null;

  // Extract transfer history from transfers result
  let transferHistory = [];
  if (transferResult && transferResult.tableData) {
    transferHistory = transferResult.tableData.map(row => ({
      date: row['Date'] || row['Transfer Date'] || row['Registration Date'] || row['Capture Date'] || null,
      price: parseInt((row['Price'] || row['Purchase Price'] || row['Amount'] || '0').replace(/[^\d]/g, '')) || null,
      buyer: row['Buyer'] || row['Purchaser'] || row['New Owner'] || null,
      seller: row['Seller'] || row['Transferor'] || row['Previous Owner'] || null,
      bond: parseInt((row['Bond'] || row['Bond Amount'] || '0').replace(/[^\d]/g, '')) || null,
    }));
  }

  return {
    erf_number: erfNumber,
    registered_owner: registeredOwner,
    title_deed_ref: titleDeedRef,
    municipal_value: municipalValue,
    lpi_code: lpiCode,
    bond_holder: bondHolder,
    bond_amount: bondAmount,
    deeds_office: deedsOffice,
    extent_sqm: extentSqm,
    township,
    transfer_history: transferHistory,
  };
}

// ─── Find or create property ──────────────────────────────────────────

async function findOrCreateProperty(erfNumber, addressRaw) {
  const { rows: existing } = await pool.query(
    'SELECT id FROM properties WHERE erf_number = $1', [erfNumber]
  );
  if (existing.length > 0) return existing[0].id;

  const { rows: created } = await pool.query(
    'INSERT INTO properties (erf_number, address_raw) VALUES ($1, $2) RETURNING id',
    [erfNumber, addressRaw]
  );
  return created[0].id;
}

// ─── Main: lookupAddress() — drop-in replacement for pipeline ─────────

async function lookupAddress(address) {
  if (!WINDEED_USERNAME || !WINDEED_PASSWORD) {
    console.warn('[windeed-browser] Credentials not set — cannot perform lookup');
    return null;
  }

  console.log(`[windeed-browser] Looking up: "${address}"`);

  try {
    // Step 1: Try Address Conversion to get ERF number
    console.log('[windeed-browser] Step 1: Address conversion...');
    const addressResult = await searchAddressConversion({ Address: address, 'Street Address': address });

    let erfNumber = null;
    let township = null;
    let deedsOffice = null;

    if (addressResult && addressResult.kvPairs) {
      erfNumber = addressResult.kvPairs['Erf Number'] || addressResult.kvPairs['ERF'] || null;
      township = addressResult.kvPairs['Township'] || null;
      deedsOffice = addressResult.kvPairs['Deeds Office'] || null;
    }

    // Also check table results from address conversion
    if (!erfNumber && addressResult && addressResult.tableData && addressResult.tableData.length > 0) {
      const firstRow = addressResult.tableData[0];
      erfNumber = firstRow['Erf Number'] || firstRow['ERF'] || firstRow['Erf'] || null;
      township = township || firstRow['Township'] || null;
      deedsOffice = deedsOffice || firstRow['Deeds Office'] || null;
    }

    if (!erfNumber) {
      console.error(`[windeed-browser] No ERF found for "${address}"`);
      return null;
    }

    console.log(`[windeed-browser] Found ERF: ${erfNumber}, Township: ${township}`);

    // Step 2: WinDeed Property search for full details
    console.log('[windeed-browser] Step 2: WinDeed Property search...');
    const propertyResult = await searchWinDeedProperty({
      propertyType: 'Erf',
      deedsOffice: deedsOffice || undefined,
      township: township || undefined,
      erfNumber,
    });

    // Step 3: Transfers search for transaction history
    console.log('[windeed-browser] Step 3: Transfers search...');
    let transferResult = null;
    try {
      transferResult = await searchTransfers({
        deedsOffice: deedsOffice || 'Cape Town',
        searchBy: 'Capture Date',
        periodType: 'Date Range',
      });
    } catch (err) {
      console.warn(`[windeed-browser] Transfers search failed (non-fatal): ${err.message}`);
    }

    // Step 4: Normalise
    const normalised = normaliseResults(propertyResult, transferResult);
    if (!normalised) {
      console.error(`[windeed-browser] Failed to normalise results for "${address}"`);
      return null;
    }

    // Use the ERF from address conversion if property search didn't return one
    normalised.erf_number = normalised.erf_number || erfNumber;

    // Step 5: Store in DB
    const propertyId = await findOrCreateProperty(normalised.erf_number, address);

    const { rows: deedsRows } = await pool.query(
      `INSERT INTO deeds_data (property_id, registered_owner, title_deed_ref,
         municipal_value, transfer_history, raw_windeed_response, lpi_code, deeds_office, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'windeed-browser')
       RETURNING id`,
      [
        propertyId,
        normalised.registered_owner,
        normalised.title_deed_ref,
        normalised.municipal_value,
        JSON.stringify(normalised.transfer_history),
        JSON.stringify({ property: propertyResult?.kvPairs, transfers: transferResult?.tableData }),
        normalised.lpi_code,
        normalised.deeds_office,
      ]
    );

    // Step 6: Update property with deeds-derived fields
    await pool.query(
      `UPDATE properties SET last_deeds_lookup = NOW(),
         lpi_code = COALESCE($1, lpi_code),
         bond_holder = COALESCE($2, bond_holder),
         bond_amount = COALESCE($3, bond_amount),
         stand_size_sqm = COALESCE($4, stand_size_sqm)
       WHERE id = $5`,
      [normalised.lpi_code, normalised.bond_holder, normalised.bond_amount,
       normalised.extent_sqm, propertyId]
    );

    console.log(`[windeed-browser] Stored deeds data for ERF ${normalised.erf_number} (property_id=${propertyId})`);

    return {
      property_id: propertyId,
      deeds_data_id: deedsRows[0].id,
      erf_number: normalised.erf_number,
      registered_owner: normalised.registered_owner,
      title_deed_ref: normalised.title_deed_ref,
      municipal_value: normalised.municipal_value,
      transfer_history: normalised.transfer_history,
    };
  } catch (err) {
    console.error(`[windeed-browser] Lookup error for "${address}":`, err.message);
    if (SCREENSHOT_ON_ERROR) {
      try { await screenshot(await getPage(), 'error'); } catch {}
    }
    return null;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  // Drop-in pipeline replacement
  lookupAddress,
  findOrCreateProperty,

  // Individual search types
  searchDeedsOfficeProperty,
  searchWinDeedProperty,
  searchAutomatedValuation,
  searchTransfers,
  searchAddressConversion,
  searchTrustPropertyHistory,

  // Utilities
  ensureLoggedIn,
  getBalance,
  closeBrowser,
  normaliseResults,

  // For testing — run headed
  getBrowser,
  getPage,
  screenshot,
};
