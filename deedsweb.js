/**
 * DeedsWeb Browser Automation — Puppeteer-based scraper for deedsweb.deeds.gov.za
 *
 * Automates the Chief Registrar of Deeds web portal (DeedsWEB).
 * No public API/WSDL exists — this drives the actual web interface.
 *
 * Registration: contact DeedsICTsupport@dalrrd.gov.za or call 012 401 9323
 * Cost: R217 one-time registration, ~R18/query
 * Portal: https://deedsweb.deeds.gov.za/deedsweb/logon.jsp
 *
 * Search types available:
 *   1. Property Enquiry — ERF, Township, Sectional Title, Farm
 *   2. Person Enquiry — by name/surname or 13-digit ID
 *   3. Company Enquiry — by company name or registration number
 *   4. Trust Enquiry — by trust name
 *   5. Title Deed Enquiry — by deed reference number
 *   6. Transfers Enquiry — by municipality/township + date range
 *
 * Drop-in replacement for windeed.js — exports lookupAddress() with same shape.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const pool = require('./db');

const DEEDSWEB_URL = 'https://deedsweb.deeds.gov.za/deedsweb';
const DEEDSWEB_USERNAME = process.env.DEEDSWEB_USERNAME;
const DEEDSWEB_PASSWORD = process.env.DEEDSWEB_PASSWORD;
const DEEDSWEB_COST_PER_QUERY = parseFloat(process.env.DEEDSWEB_COST_PER_QUERY || '18');
const SESSION_DIR = path.resolve(__dirname, 'data', 'deedsweb-session');
const SAMPLES_DIR = path.resolve(__dirname, 'data', 'deedsweb-samples');
const DEFAULT_TIMEOUT = 30000;
const NAV_DELAY = 2000;

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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  });
  return _browser;
}

async function getPage() {
  if (_page && !_page.isClosed()) return _page;
  const browser = await getBrowser();
  _page = await browser.newPage();
  await _page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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

// ─── Screenshot / debug ───────────────────────────────────────────────

async function screenshot(page, name) {
  ensureDir(SAMPLES_DIR);
  const file = path.join(SAMPLES_DIR, `${name}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`[deedsweb] Screenshot: ${file}`);
  return file;
}

async function saveHTML(page, name) {
  ensureDir(SAMPLES_DIR);
  const html = await page.content();
  const file = path.join(SAMPLES_DIR, `${name}-${Date.now()}.html`);
  fs.writeFileSync(file, html);
  return file;
}

// ─── Login ────────────────────────────────────────────────────────────

async function ensureLoggedIn(page) {
  await page.goto(`${DEEDSWEB_URL}/logon.jsp`, { waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT });
  await sleep(1000);

  const bodyText = await page.evaluate(() => document.body.innerText);

  // Check if already in a logged-in session (look for search/enquiry options)
  if (bodyText.includes('Property Enquiry') || bodyText.includes('Person Enquiry') ||
      bodyText.includes('Enquiry') && bodyText.includes('Logout')) {
    console.log('[deedsweb] Already logged in');
    return true;
  }

  if (!DEEDSWEB_USERNAME || !DEEDSWEB_PASSWORD) {
    throw new Error('DEEDSWEB_USERNAME and DEEDSWEB_PASSWORD must be set in .env');
  }

  console.log('[deedsweb] Logging in...');

  // DeedsWeb login form — try standard form selectors
  const usernameSelectors = [
    'input[name="username"]', 'input[name="user"]', 'input[name="j_username"]',
    'input[name="txtUsername"]', 'input[name="UserName"]',
    'input[type="text"]:first-of-type', '#username', '#user',
  ];
  const passwordSelectors = [
    'input[name="password"]', 'input[name="pass"]', 'input[name="j_password"]',
    'input[name="txtPassword"]', 'input[name="Password"]',
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
    await saveHTML(page, 'login-page');
    throw new Error(`Login form not found — check ${SAMPLES_DIR} for screenshots`);
  }

  await usernameInput.click({ clickCount: 3 });
  await usernameInput.type(DEEDSWEB_USERNAME, { delay: 30 });
  await passwordInput.click({ clickCount: 3 });
  await passwordInput.type(DEEDSWEB_PASSWORD, { delay: 30 });

  // Submit
  const submitBtn = await page.$('input[type="submit"], button[type="submit"], input[value="Login"], input[value="Log In"], input[value="Logon"]');
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await passwordInput.press('Enter');
  }

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT }).catch(() => {});
  await sleep(2000);

  const postLoginText = await page.evaluate(() => document.body.innerText);
  if (postLoginText.includes('Enquiry') || postLoginText.includes('Property') || postLoginText.includes('Search')) {
    console.log('[deedsweb] Login successful');
    return true;
  }

  await screenshot(page, 'login-failed');
  await saveHTML(page, 'login-failed');
  throw new Error('Login failed — check screenshots in ' + SAMPLES_DIR);
}

// ─── Navigation helpers ───────────────────────────────────────────────

async function navigateTo(page, linkText) {
  const clicked = await page.evaluate((text) => {
    const links = [...document.querySelectorAll('a, input[type="submit"], button, td, span')];
    for (const el of links) {
      const t = (el.textContent || el.value || '').trim();
      if (t.toLowerCase().includes(text.toLowerCase())) {
        el.click();
        return true;
      }
    }
    return false;
  }, linkText);

  if (!clicked) {
    throw new Error(`Could not find link/button: "${linkText}"`);
  }

  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT }).catch(() => {}),
    sleep(3000),
  ]);
  await sleep(NAV_DELAY);
}

// ─── Form helpers ─────────────────────────────────────────────────────

async function selectOption(page, selectNameOrId, value) {
  if (!value) return;
  await page.evaluate((nameOrId, val) => {
    const selects = document.querySelectorAll('select');
    for (const select of selects) {
      if (select.name === nameOrId || select.id === nameOrId ||
          select.name?.toLowerCase().includes(nameOrId.toLowerCase())) {
        for (const opt of select.options) {
          if (opt.text.toLowerCase().includes(val.toLowerCase()) ||
              opt.value.toLowerCase().includes(val.toLowerCase())) {
            select.value = opt.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
      }
    }
    // Fallback: find by nearby label text
    const labels = [...document.querySelectorAll('td, th, label')];
    for (const lbl of labels) {
      if (lbl.textContent.trim().toLowerCase().includes(nameOrId.toLowerCase())) {
        const row = lbl.closest('tr') || lbl.parentElement;
        const select = row?.querySelector('select');
        if (select) {
          for (const opt of select.options) {
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
  }, selectNameOrId, value);
  await sleep(500);
}

async function fillInput(page, nameOrLabel, value) {
  if (!value) return;
  const filled = await page.evaluate((nameOrLabel, val) => {
    // Try by name/id first
    let input = document.querySelector(`input[name="${nameOrLabel}"]`) ||
                document.querySelector(`input[id="${nameOrLabel}"]`);
    if (input) {
      input.value = val;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    // Try by label text
    const labels = [...document.querySelectorAll('td, th, label')];
    for (const lbl of labels) {
      if (lbl.textContent.trim().toLowerCase().includes(nameOrLabel.toLowerCase())) {
        const row = lbl.closest('tr') || lbl.parentElement;
        input = row?.querySelector('input[type="text"], input:not([type])');
        if (input) {
          input.value = val;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }
    }
    return false;
  }, nameOrLabel, value);
  if (!filled) {
    console.warn(`[deedsweb] Could not fill "${nameOrLabel}" with "${value}"`);
  }
  await sleep(300);
}

async function submitForm(page) {
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('input[type="submit"], button[type="submit"], input[value="Search"], input[value="Find"], a.button, input[type="button"]')];
    for (const btn of btns) {
      const val = (btn.value || btn.textContent || '').toLowerCase();
      if (val.includes('search') || val.includes('find') || val.includes('enquiry') || val.includes('submit')) {
        btn.click();
        return true;
      }
    }
    return false;
  });
  if (!clicked) {
    // Try pressing Enter on the last input
    await page.keyboard.press('Enter');
  }
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT }).catch(() => {}),
    sleep(5000),
  ]);
  await sleep(2000);
}

// ─── Results extraction ───────────────────────────────────────────────

async function extractResults(page, label) {
  // Screenshot + save HTML for debugging/discovery
  await screenshot(page, `results-${label}`);
  await saveHTML(page, `results-${label}`);

  const bodyText = await page.evaluate(() => document.body.innerText);

  // Check for errors
  if (bodyText.includes('No records') || bodyText.includes('no records') || bodyText.includes('0 records')) {
    console.log(`[deedsweb] No results for ${label}`);
    return null;
  }

  // Extract all tables
  const tables = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('table').forEach(table => {
      const headers = [...table.querySelectorAll('th, thead td')].map(th => th.textContent.trim());
      if (headers.length === 0) return;

      const rows = [];
      table.querySelectorAll('tbody tr, tr').forEach(tr => {
        const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
        if (cells.length > 0 && cells.length >= headers.length - 1) {
          const obj = {};
          cells.forEach((cell, i) => { obj[headers[i] || `col_${i}`] = cell; });
          rows.push(obj);
        }
      });

      if (rows.length > 0) results.push({ headers, rows });
    });
    return results;
  });

  // Extract key-value pairs (detail views use label: value in table rows)
  const kvPairs = await page.evaluate(() => {
    const pairs = {};
    document.querySelectorAll('tr').forEach(tr => {
      const cells = [...tr.querySelectorAll('td')];
      if (cells.length === 2) {
        const key = cells[0].textContent.trim().replace(/:$/, '');
        const val = cells[1].textContent.trim();
        if (key && val && key.length < 50 && key !== val) {
          pairs[key] = val;
        }
      }
    });
    return pairs;
  });

  // Check for clickable detail links in results
  const detailLinks = await page.evaluate(() => {
    const links = [];
    document.querySelectorAll('a[href], td a').forEach(a => {
      const text = a.textContent.trim();
      const href = a.href;
      if (text && href && !href.includes('javascript:void') && text.length < 100) {
        links.push({ text, href });
      }
    });
    return links;
  });

  return { tables, kvPairs, detailLinks, bodyText: bodyText.substring(0, 5000) };
}

// ─── Property Enquiry ─────────────────────────────────────────────────

async function searchProperty({ deedsOffice, propertyType, township, erfNumber, portionNumber } = {}) {
  const page = await getPage();
  await ensureLoggedIn(page);

  console.log(`[deedsweb] Property Enquiry: ERF ${erfNumber}, Township: ${township}, Office: ${deedsOffice}`);

  await navigateTo(page, 'Property Enquiry');
  await sleep(1000);

  // Select deeds office (registrar)
  if (deedsOffice) await selectOption(page, 'registrar', deedsOffice);
  if (deedsOffice) await selectOption(page, 'office', deedsOffice);

  // Property type (ERF is the most common for residential)
  if (propertyType) await selectOption(page, 'type', propertyType);

  // Township and ERF number
  if (township) await fillInput(page, 'township', township);
  if (township) await fillInput(page, 'Township', township);
  if (erfNumber) await fillInput(page, 'erf', erfNumber);
  if (erfNumber) await fillInput(page, 'Erf', erfNumber);
  if (portionNumber) await fillInput(page, 'portion', portionNumber);

  await screenshot(page, 'property-form-filled');
  await submitForm(page);

  const results = await extractResults(page, 'property');

  // If results have clickable links, click the first one for detail view
  if (results && results.detailLinks && results.detailLinks.length > 0) {
    console.log(`[deedsweb] Clicking first result for details...`);
    try {
      await page.evaluate((href) => {
        const link = document.querySelector(`a[href="${href}"]`) ||
                     [...document.querySelectorAll('a')].find(a => a.href === href);
        if (link) link.click();
      }, results.detailLinks[0].href);
      await sleep(3000);
      const detail = await extractResults(page, 'property-detail');
      if (detail) {
        results.detail = detail;
      }
    } catch (err) {
      console.warn(`[deedsweb] Detail click failed: ${err.message}`);
    }
  }

  await logCost('property_enquiry');
  return results;
}

// ─── Person Enquiry ───────────────────────────────────────────────────

async function searchPerson({ deedsOffice, surname, names, idNumber } = {}) {
  const page = await getPage();
  await ensureLoggedIn(page);

  console.log(`[deedsweb] Person Enquiry: ${surname || idNumber}`);

  await navigateTo(page, 'Person Enquiry');
  await sleep(1000);

  if (deedsOffice) await selectOption(page, 'registrar', deedsOffice);
  if (deedsOffice) await selectOption(page, 'office', deedsOffice);
  if (surname) await fillInput(page, 'surname', surname);
  if (names) await fillInput(page, 'name', names);
  if (idNumber) await fillInput(page, 'id', idNumber);

  await submitForm(page);
  const results = await extractResults(page, 'person');
  await logCost('person_enquiry');
  return results;
}

// ─── Title Deed Enquiry ───────────────────────────────────────────────

async function searchTitleDeed({ deedsOffice, deedNumber } = {}) {
  const page = await getPage();
  await ensureLoggedIn(page);

  console.log(`[deedsweb] Title Deed Enquiry: ${deedNumber}`);

  await navigateTo(page, 'Title Deed');
  await sleep(1000);

  if (deedsOffice) await selectOption(page, 'registrar', deedsOffice);
  if (deedsOffice) await selectOption(page, 'office', deedsOffice);
  if (deedNumber) await fillInput(page, 'deed', deedNumber);

  await submitForm(page);
  const results = await extractResults(page, 'title-deed');
  await logCost('title_deed_enquiry');
  return results;
}

// ─── Transfers Enquiry ────────────────────────────────────────────────

async function searchTransfers({ deedsOffice, municipality, township, dateFrom, dateTo } = {}) {
  const page = await getPage();
  await ensureLoggedIn(page);

  console.log(`[deedsweb] Transfers Enquiry: ${municipality || township}`);

  await navigateTo(page, 'Transfer');
  await sleep(1000);

  if (deedsOffice) await selectOption(page, 'registrar', deedsOffice);
  if (deedsOffice) await selectOption(page, 'office', deedsOffice);
  if (municipality) await fillInput(page, 'municipality', municipality);
  if (township) await fillInput(page, 'township', township);
  if (dateFrom) await fillInput(page, 'from', dateFrom);
  if (dateTo) await fillInput(page, 'to', dateTo);

  await submitForm(page);
  const results = await extractResults(page, 'transfers');
  await logCost('transfers_enquiry');
  return results;
}

// ─── Normalise results ────────────────────────────────────────────────

function normalisePropertyResults(results) {
  if (!results) return null;

  const kv = results.detail?.kvPairs || results.kvPairs || {};
  const allRows = results.tables?.flatMap(t => t.rows) || [];

  // Try key-value pairs first (detail view)
  let erfNumber = kv['Erf Number'] || kv['Erf'] || kv['ERF'] || kv['Property'] || null;
  let registeredOwner = kv['Owner'] || kv['Registered Owner'] || kv['Owner Name'] || null;
  let titleDeedRef = kv['Title Deed'] || kv['Deed Number'] || kv['Deed'] || kv['Title'] || null;
  let municipalValue = parseInt((kv['Municipal Value'] || kv['Valuation'] || kv['Market Value'] || '0').replace(/[^\d]/g, '')) || null;
  let lpiCode = kv['LPI'] || kv['LPI Code'] || null;
  let bondHolder = kv['Bond Holder'] || kv['Bondholder'] || kv['Bond holder'] || null;
  let bondAmount = parseInt((kv['Bond Amount'] || kv['Bond'] || '0').replace(/[^\d]/g, '')) || null;
  let deedsOffice = kv['Deeds Office'] || kv['Registry'] || kv['Registrar'] || null;
  let extentSqm = parseInt((kv['Extent'] || kv['Size'] || kv['Area'] || '0').replace(/[^\d]/g, '')) || null;
  let township = kv['Township'] || null;

  // Fall back to first table row
  if (!erfNumber && allRows.length > 0) {
    const row = allRows[0];
    erfNumber = row['Erf'] || row['Erf Number'] || row['ERF'] || row['Property'] || null;
    registeredOwner = registeredOwner || row['Owner'] || row['Registered Owner'] || null;
    township = township || row['Township'] || null;
  }

  // Transfer history from transfers tables
  let transferHistory = [];
  if (results.tables) {
    for (const table of results.tables) {
      if (table.headers.some(h => h.toLowerCase().includes('transfer') || h.toLowerCase().includes('date') || h.toLowerCase().includes('price'))) {
        transferHistory = table.rows.map(row => ({
          date: row['Date'] || row['Transfer Date'] || row['Registration Date'] || null,
          price: parseInt((row['Price'] || row['Purchase Price'] || row['Amount'] || '0').replace(/[^\d]/g, '')) || null,
          buyer: row['Buyer'] || row['Purchaser'] || row['New Owner'] || null,
          seller: row['Seller'] || row['Transferor'] || row['Previous Owner'] || null,
          bond: parseInt((row['Bond'] || row['Bond Amount'] || '0').replace(/[^\d]/g, '')) || null,
        }));
      }
    }
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

// ─── Cost logging ─────────────────────────────────────────────────────

async function logCost(action) {
  try {
    const { logCost } = require('./costs');
    await logCost('deedsweb', action, DEEDSWEB_COST_PER_QUERY / 18.5);
  } catch {}
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
  if (!DEEDSWEB_USERNAME || !DEEDSWEB_PASSWORD) {
    console.warn('[deedsweb] Credentials not set — skipping deeds lookup');
    return null;
  }

  console.log(`[deedsweb] Looking up: "${address}"`);

  try {
    // Step 1: Property enquiry
    // Parse address to extract potential township/suburb
    const parts = address.split(',').map(s => s.trim());
    const township = parts[1] || parts[0]; // Usually "suburb" in SA addresses

    const propertyResult = await searchProperty({
      propertyType: 'ERF',
      township,
    });

    const normalised = normalisePropertyResults(propertyResult);
    if (!normalised || !normalised.erf_number) {
      console.error(`[deedsweb] No property found for "${address}"`);
      return null;
    }

    console.log(`[deedsweb] Found ERF: ${normalised.erf_number}, Owner: ${normalised.registered_owner}`);

    // Step 2: Try transfers enquiry for history
    if (normalised.township || township) {
      try {
        const transferResult = await searchTransfers({
          township: normalised.township || township,
        });
        if (transferResult) {
          const transferNorm = normalisePropertyResults(transferResult);
          if (transferNorm && transferNorm.transfer_history.length > 0) {
            normalised.transfer_history = transferNorm.transfer_history;
          }
        }
      } catch (err) {
        console.warn(`[deedsweb] Transfers search failed (non-fatal): ${err.message}`);
      }
    }

    // Step 3: Store in DB
    const propertyId = await findOrCreateProperty(normalised.erf_number, address);

    const { rows: deedsRows } = await pool.query(
      `INSERT INTO deeds_data (property_id, registered_owner, title_deed_ref,
         municipal_value, transfer_history, raw_deedsweb_response, lpi_code, deeds_office, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'deedsweb')
       RETURNING id`,
      [
        propertyId,
        normalised.registered_owner,
        normalised.title_deed_ref,
        normalised.municipal_value,
        JSON.stringify(normalised.transfer_history),
        JSON.stringify({ property: propertyResult?.kvPairs, tables: propertyResult?.tables }),
        normalised.lpi_code,
        normalised.deeds_office,
      ]
    );

    // Step 4: Update property with deeds-derived fields
    await pool.query(
      `UPDATE properties SET last_deeds_lookup = NOW(),
         lpi_code = COALESCE($1, lpi_code),
         owner_id_number = COALESCE($2, owner_id_number),
         bond_holder = COALESCE($3, bond_holder),
         bond_amount = COALESCE($4, bond_amount),
         stand_size_sqm = COALESCE($5, stand_size_sqm)
       WHERE id = $6`,
      [normalised.lpi_code, null, normalised.bond_holder,
       normalised.bond_amount, normalised.extent_sqm, propertyId]
    );

    console.log(`[deedsweb] Stored deeds for ERF ${normalised.erf_number} (property_id=${propertyId})`);

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
    console.error(`[deedsweb] Lookup error for "${address}":`, err.message);
    try { await screenshot(await getPage(), 'error'); } catch {}
    return null;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  // Drop-in pipeline replacement
  lookupAddress,
  findOrCreateProperty,

  // Individual search types
  searchProperty,
  searchPerson,
  searchTitleDeed,
  searchTransfers,

  // Utilities
  ensureLoggedIn,
  closeBrowser,
  normalisePropertyResults,

  // For testing
  getBrowser,
  getPage,
  screenshot,
  saveHTML,
};
