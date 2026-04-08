/**
 * SA Property Extra Costs Collector
 *
 * Calculates the REAL cost of buying a property beyond the asking price:
 * - Transfer duty (SARS sliding scale)
 * - Bond registration costs (Deeds Office)
 * - Conveyancing/attorney fees (Law Society guidelines)
 * - Estate agent commission (industry standard)
 * - Bond initiation fees (bank charges)
 * - Rates clearance certificate
 * - Compliance certificates (electrical, plumbing, gas, beetle, electric fence)
 * - Monthly ongoing costs (rates, levies, insurance estimate)
 *
 * All figures use 2025/2026 South African rates.
 * No external API needed — pure calculation from SARS/industry tables.
 */
const pool = require('./db');

// ─── Transfer Duty (SARS 2025/2026) ───────────────────────────────────
// Updated 1 March 2025 — Property transfers on/after this date
function calcTransferDuty(price) {
  if (price <= 1100000) return 0;
  if (price <= 1512500) return (price - 1100000) * 0.03;
  if (price <= 2117500) return 12375 + (price - 1512500) * 0.06;
  if (price <= 2722500) return 48675 + (price - 2117500) * 0.08;
  if (price <= 12100000) return 97075 + (price - 2722500) * 0.11;
  return 1128600 + (price - 12100000) * 0.13;
}

// ─── Conveyancing fees (Law Society guideline tariff 2025) ─────────────
// Transfer attorney fees — based on property value
function calcConveyancingFees(price) {
  const table = [
    [0, 100000, 7200],
    [100001, 200000, 9000],
    [200001, 300000, 11000],
    [300001, 500000, 13500],
    [500001, 800000, 16500],
    [800001, 1000000, 19500],
    [1000001, 2000000, 25000],
    [2000001, 4000000, 35000],
    [4000001, 8000000, 50000],
    [8000001, 16000000, 70000],
    [16000001, Infinity, 90000],
  ];
  for (const [min, max, fee] of table) {
    if (price >= min && price <= max) return fee;
  }
  return 90000;
}

// ─── Bond registration costs ──────────────────────────────────────────
// Deeds Office fees + bond attorney fees
function calcBondCosts(bondAmount) {
  if (!bondAmount || bondAmount <= 0) return { bond_attorney: 0, deeds_office: 0, bank_initiation: 0 };

  // Bond attorney fees (similar scale to conveyancing)
  let bondAttorney = 8000;
  if (bondAmount > 200000) bondAttorney = 10500;
  if (bondAmount > 500000) bondAttorney = 14000;
  if (bondAmount > 1000000) bondAttorney = 20000;
  if (bondAmount > 2000000) bondAttorney = 30000;
  if (bondAmount > 4000000) bondAttorney = 42000;

  // Deeds Office registration fee
  let deedsOffice = 250;
  if (bondAmount > 150000) deedsOffice = 350;
  if (bondAmount > 300000) deedsOffice = 550;
  if (bondAmount > 600000) deedsOffice = 890;
  if (bondAmount > 1500000) deedsOffice = 1290;
  if (bondAmount > 3000000) deedsOffice = 1890;

  // Bank bond initiation fee (standard across most SA banks)
  const bankInitiation = 6037.50; // Standard 2025 rate (was R5750 in 2024)

  return { bond_attorney: bondAttorney, deeds_office: deedsOffice, bank_initiation: bankInitiation };
}

// ─── Compliance certificates ──────────────────────────────────────────
function calcComplianceCerts(propertyType) {
  const isApartment = (propertyType || '').toLowerCase().includes('apartment') ||
                      (propertyType || '').toLowerCase().includes('flat');
  return {
    electrical_compliance: 2500,   // CoC — mandatory for all transfers
    plumbing_compliance: isApartment ? 0 : 1500, // Required by some metros
    gas_compliance: 800,           // If gas installation exists
    beetle_certificate: isApartment ? 0 : 1200,  // Entomologist inspection
    electric_fence: isApartment ? 0 : 1500,       // If electric fence exists
  };
}

// ─── Estate agent commission ──────────────────────────────────────────
function calcAgentCommission(price) {
  // Industry standard: 5-7.5% on properties under R2M, then negotiable
  // Most common: sole mandate 6%, open mandate 7.5%
  // Properties over R5M typically 4-5%
  if (price >= 5000000) return { rate_pct: 4.5, amount: Math.round(price * 0.045) };
  if (price >= 2000000) return { rate_pct: 5.0, amount: Math.round(price * 0.05) };
  return { rate_pct: 6.0, amount: Math.round(price * 0.06) };
}

// ─── Monthly cost estimates ───────────────────────────────────────────
function calcMonthlyCosts(price, levies, ratesAndTaxes) {
  // Home insurance estimate (typical SA rates: 0.1-0.2% of property value per month)
  const insuranceMonthly = Math.round(price * 0.0012 / 12); // ~0.12% p.a.

  // If we don't have actual levies/rates, estimate from property value
  const estimatedLevies = levies || (price < 1500000 ? 1200 : price < 3000000 ? 2500 : 4000);
  const estimatedRates = ratesAndTaxes || Math.round(price * 0.008 / 12); // ~0.8% p.a.

  return {
    levies_monthly: estimatedLevies,
    rates_monthly: estimatedRates,
    insurance_monthly: insuranceMonthly,
    total_monthly: estimatedLevies + estimatedRates + insuranceMonthly,
  };
}

// ─── Bond repayment estimate ──────────────────────────────────────────
function calcBondRepayment(bondAmount, interestRate = 11.75, termYears = 20) {
  // SA prime rate (March 2025): 11.50% — typical bond = prime + 0.25%
  const r = interestRate / 100 / 12;
  const n = termYears * 12;
  const monthly = bondAmount * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  const totalInterest = (monthly * n) - bondAmount;
  return {
    monthly_repayment: Math.round(monthly),
    total_interest: Math.round(totalInterest),
    total_cost: Math.round(monthly * n),
    interest_rate: interestRate,
    term_years: termYears,
  };
}

/**
 * Calculate all property costs for a property.
 * Stores results in area_risk_data with risk_type='property_costs'.
 */
async function collectForProperty(propertyId) {
  const { rows } = await pool.query(
    `SELECT id, suburb, city, asking_price, levies, rates_and_taxes, property_type, floor_area_sqm
     FROM properties WHERE id = $1`, [propertyId]
  );
  if (!rows[0]) return { error: 'property not found' };

  const prop = rows[0];
  const price = prop.asking_price;
  if (!price || price <= 0) return { error: 'no asking price' };

  const suburb = prop.suburb;
  const city = prop.city;
  if (!suburb) return { error: 'no suburb' };

  // Assume 90% bond (10% deposit is typical minimum in SA)
  const deposit = Math.round(price * 0.10);
  const bondAmount = price - deposit;

  const transferDuty = calcTransferDuty(price);
  const conveyancing = calcConveyancingFees(price);
  const bondCosts = calcBondCosts(bondAmount);
  const compliance = calcComplianceCerts(prop.property_type);
  const agent = calcAgentCommission(price);
  const monthly = calcMonthlyCosts(price, prop.levies, prop.rates_and_taxes);
  const bond = calcBondRepayment(bondAmount);

  // VAT on attorney fees (15%)
  const vatOnFees = Math.round((conveyancing + bondCosts.bond_attorney) * 0.15);

  const totalComplianceCerts = Object.values(compliance).reduce((s, v) => s + v, 0);

  const totalOnceOff = transferDuty + conveyancing + bondCosts.bond_attorney +
    bondCosts.deeds_office + bondCosts.bank_initiation + vatOnFees +
    totalComplianceCerts + 1500; // R1500 rates clearance cert

  const realCost = price + totalOnceOff;

  const result = {
    asking_price: price,
    deposit,
    bond_amount: bondAmount,
    transfer_duty: transferDuty,
    conveyancing_fees: conveyancing,
    bond_attorney_fees: bondCosts.bond_attorney,
    deeds_office_fee: bondCosts.deeds_office,
    bank_initiation_fee: bondCosts.bank_initiation,
    vat_on_fees: vatOnFees,
    rates_clearance: 1500,
    compliance_certificates: compliance,
    total_compliance: totalComplianceCerts,
    agent_commission: agent,
    total_once_off_costs: totalOnceOff,
    real_purchase_cost: realCost,
    premium_over_asking_pct: Math.round((totalOnceOff / price) * 10000) / 100,
    bond_repayment: bond,
    monthly_costs: monthly,
    total_monthly_with_bond: bond.monthly_repayment + monthly.total_monthly,
  };

  console.log(`[costs] ${suburb}: R${price.toLocaleString()} asking → R${realCost.toLocaleString()} real (+${result.premium_over_asking_pct}%), R${result.total_monthly_with_bond.toLocaleString()}/month`);

  // Store per-property cost breakdown
  try {
    await pool.query(
      `UPDATE properties SET
        extra_costs_json = $1,
        total_purchase_cost = $2,
        monthly_total_cost = $3
       WHERE id = $4`,
      [JSON.stringify(result), realCost, result.total_monthly_with_bond, propertyId]
    );
  } catch (e) {
    // Columns may not exist yet — add them
    try {
      await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS extra_costs_json JSONB`);
      await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS total_purchase_cost INTEGER`);
      await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS monthly_total_cost INTEGER`);
      await pool.query(
        `UPDATE properties SET extra_costs_json = $1, total_purchase_cost = $2, monthly_total_cost = $3 WHERE id = $4`,
        [JSON.stringify(result), realCost, result.total_monthly_with_bond, propertyId]
      );
    } catch (e2) { console.error(`[costs] DB error for ${suburb}:`, e2.message); }
  }

  return result;
}

module.exports = { collectForProperty, calcTransferDuty, calcBondCosts, calcConveyancingFees, calcAgentCommission, calcBondRepayment, calcMonthlyCosts };
