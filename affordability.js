/**
 * SA Property Affordability & Transfer Cost Calculator
 *
 * Calculates all costs associated with buying a property in South Africa:
 * - Transfer duty (SARS sliding scale)
 * - Conveyancing/transfer attorney fees
 * - Bond registration costs
 * - Deeds office fees
 * - Monthly carrying costs (bond + levies + rates + insurance)
 *
 * All rates as of 2025/2026 tax year.
 */

// ─── Transfer Duty (SARS 2025/2026) ────────────────────────────────────
// No transfer duty on properties <= R1,100,000
// Sliding scale above that
function calculateTransferDuty(purchasePrice) {
  if (!purchasePrice || purchasePrice <= 0) return 0;
  const p = purchasePrice;

  if (p <= 1100000) return 0;
  if (p <= 1512500) return (p - 1100000) * 0.03;
  if (p <= 2117500) return 12375 + (p - 1512500) * 0.06;
  if (p <= 2722500) return 48675 + (p - 2117500) * 0.08;
  if (p <= 12100000) return 97075 + (p - 2722500) * 0.11;
  return 1128600 + (p - 12100000) * 0.13;
}

// ─── Conveyancing Fees (Guideline tariff 2025) ─────────────────────────
// Based on Law Society recommended tariff (excl. VAT)
function calculateConveyancingFees(purchasePrice) {
  if (!purchasePrice || purchasePrice <= 0) return 0;
  const p = purchasePrice;

  let fee;
  if (p <= 100000) fee = 5500;
  else if (p <= 500000) fee = 5500 + (p - 100000) * 0.01;
  else if (p <= 1000000) fee = 9500 + (p - 500000) * 0.008;
  else if (p <= 2000000) fee = 13500 + (p - 1000000) * 0.005;
  else if (p <= 5000000) fee = 18500 + (p - 2000000) * 0.003;
  else fee = 27500 + (p - 5000000) * 0.002;

  // Add VAT (15%)
  return Math.round(fee * 1.15);
}

// ─── Bond Registration Costs ────────────────────────────────────────────
// Bond attorney fees + deeds office fees
function calculateBondCosts(bondAmount) {
  if (!bondAmount || bondAmount <= 0) return { attorney: 0, deedsOffice: 0, total: 0 };

  // Bond attorney fees (similar scale to conveyancing)
  let attorney;
  if (bondAmount <= 100000) attorney = 4500;
  else if (bondAmount <= 500000) attorney = 4500 + (bondAmount - 100000) * 0.008;
  else if (bondAmount <= 1000000) attorney = 7700 + (bondAmount - 500000) * 0.006;
  else if (bondAmount <= 2000000) attorney = 10700 + (bondAmount - 1000000) * 0.004;
  else attorney = 14700 + (bondAmount - 2000000) * 0.002;

  attorney = Math.round(attorney * 1.15); // VAT

  // Deeds office fee (flat rate based on bond value)
  let deedsOffice;
  if (bondAmount <= 150000) deedsOffice = 300;
  else if (bondAmount <= 300000) deedsOffice = 400;
  else if (bondAmount <= 600000) deedsOffice = 500;
  else if (bondAmount <= 1000000) deedsOffice = 600;
  else if (bondAmount <= 2000000) deedsOffice = 800;
  else deedsOffice = 1000;

  return { attorney, deedsOffice, total: attorney + deedsOffice };
}

// ─── Monthly Bond Payment ───────────────────────────────────────────────
// Standard amortisation at SA prime rate
function calculateMonthlyBondPayment(bondAmount, interestRate = 11.75, termYears = 20) {
  if (!bondAmount || bondAmount <= 0) return 0;
  const monthlyRate = interestRate / 100 / 12;
  const numPayments = termYears * 12;
  return Math.round(bondAmount * (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1));
}

// ─── Full Affordability Breakdown ───────────────────────────────────────
function calculateFullCosts(purchasePrice, deposit = 0, interestRate = 11.75, termYears = 20) {
  const bondAmount = Math.max(0, purchasePrice - deposit);
  const transferDuty = calculateTransferDuty(purchasePrice);
  const conveyancing = calculateConveyancingFees(purchasePrice);
  const bondCosts = calculateBondCosts(bondAmount);
  const monthlyBond = calculateMonthlyBondPayment(bondAmount, interestRate, termYears);

  // Bank initiation fee (typically R6,037.50 incl VAT in 2025)
  const bankInitiation = 6038;

  const totalOnceOff = transferDuty + conveyancing + bondCosts.total + bankInitiation + deposit;
  const totalBondCost = monthlyBond * termYears * 12;

  return {
    purchase_price: purchasePrice,
    deposit,
    bond_amount: bondAmount,
    interest_rate: interestRate,
    term_years: termYears,

    // Once-off costs
    transfer_duty: transferDuty,
    conveyancing_fees: conveyancing,
    bond_attorney_fees: bondCosts.attorney,
    deeds_office_fees: bondCosts.deedsOffice,
    bank_initiation_fee: bankInitiation,
    total_once_off: totalOnceOff,

    // Monthly costs
    monthly_bond_payment: monthlyBond,
    total_interest_over_term: totalBondCost - bondAmount,
    total_cost_over_term: totalBondCost,

    // Summary
    cash_needed_upfront: totalOnceOff,
    true_cost: purchasePrice + transferDuty + conveyancing + bondCosts.total + bankInitiation + (totalBondCost - bondAmount),
  };
}

// ─── Market Value Comparison ────────────────────────────────────────────
function compareMarketValue(askingPrice, municipalValue, soldPricesMedian, avmEstimate) {
  const comparisons = [];

  if (municipalValue && municipalValue > 0) {
    const diff = ((askingPrice / municipalValue) - 1) * 100;
    comparisons.push({
      benchmark: 'Municipal Valuation',
      value: municipalValue,
      diff_pct: Math.round(diff),
      verdict: diff > 30 ? 'significantly_above' : diff > 10 ? 'above' : diff > -5 ? 'fair' : 'below',
      note: diff > 30 ? `Asking ${Math.round(diff)}% above municipal value — substantial premium, negotiate hard`
        : diff > 10 ? `Asking ${Math.round(diff)}% above municipal value — some premium, room to negotiate`
        : diff > -5 ? `Asking price in line with municipal value — fair pricing`
        : `Asking ${Math.abs(Math.round(diff))}% below municipal value — potential bargain or underlying issues`,
    });
  }

  if (soldPricesMedian && soldPricesMedian > 0) {
    const diff = ((askingPrice / soldPricesMedian) - 1) * 100;
    comparisons.push({
      benchmark: 'Suburb Sold Median',
      value: soldPricesMedian,
      diff_pct: Math.round(diff),
      verdict: diff > 20 ? 'significantly_above' : diff > 5 ? 'above' : diff > -10 ? 'fair' : 'below',
      note: diff > 20 ? `Asking ${Math.round(diff)}% above recent suburb sales — overpriced relative to what buyers are actually paying`
        : diff > 5 ? `Asking ${Math.round(diff)}% above suburb median — slight premium`
        : diff > -10 ? `In line with recent sales in the area — fair market price`
        : `${Math.abs(Math.round(diff))}% below suburb median — investigate why`,
    });
  }

  if (avmEstimate && avmEstimate > 0) {
    const diff = ((askingPrice / avmEstimate) - 1) * 100;
    comparisons.push({
      benchmark: 'AI Valuation Estimate',
      value: avmEstimate,
      diff_pct: Math.round(diff),
      verdict: diff > 15 ? 'above' : diff > -5 ? 'fair' : 'below',
      note: diff > 15 ? `Asking ${Math.round(diff)}% above our AI estimate`
        : diff > -5 ? `Close to AI estimated value`
        : `Below AI estimate by ${Math.abs(Math.round(diff))}%`,
    });
  }

  const overallVerdict = comparisons.some(c => c.verdict === 'significantly_above') ? 'overpriced'
    : comparisons.every(c => c.verdict === 'below') ? 'potential_bargain'
    : comparisons.some(c => c.verdict === 'above') ? 'slightly_above'
    : 'fair';

  return { comparisons, overall_verdict: overallVerdict };
}

module.exports = {
  calculateTransferDuty,
  calculateConveyancingFees,
  calculateBondCosts,
  calculateMonthlyBondPayment,
  calculateFullCosts,
  compareMarketValue,
};
