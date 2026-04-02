const pool = require('./db');

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- 3 test properties ---
    const { rows: props } = await client.query(`
      INSERT INTO properties (erf_number, address_raw, address_normalised, suburb, city, province, lat, lng, property_type, stand_size_sqm, floor_area_sqm, bedrooms, bathrooms, construction_era, solar_installed, security_visible, roof_material, roof_orientation, suburb_crime_score)
      VALUES
        ('ERF12345', '14 Kloof Street, Gardens, Cape Town', '14 Kloof St, Gardens, Cape Town, 8001', 'Gardens', 'Cape Town', 'Western Cape', -33.9271000, 18.4100900, 'freehold', 650, 220, 3, 2, '1960s', false, true, 'concrete_tile', 'north', 4),
        ('ERF67890', '8 Jan Smuts Ave, Rosebank, Johannesburg', '8 Jan Smuts Ave, Rosebank, JHB, 2196', 'Rosebank', 'Johannesburg', 'Gauteng', -26.1460000, 28.0440000, 'sectional', 0, 95, 2, 1, '2005', false, true, 'concrete_tile', 'east', 6),
        ('ERF11223', '22 Marine Drive, Umhlanga, Durban', '22 Marine Dr, Umhlanga, Durban, 4319', 'Umhlanga', 'Durban', 'KwaZulu-Natal', -29.7270000, 31.0870000, 'freehold', 800, 310, 4, 3, '1985', true, true, 'clay_tile', 'north', 3)
      RETURNING id
    `);

    const [prop1, prop2, prop3] = props.map(r => r.id);
    console.log(`Inserted 3 properties: IDs ${prop1}, ${prop2}, ${prop3}`);

    // --- 1 test property_report with all B2B score fields ---
    const { rows: reports } = await client.query(`
      INSERT INTO property_reports (
        property_id, asking_price, avm_low, avm_high, price_verdict,
        comparables, suburb_intelligence, vision_findings,
        asbestos_risk, structural_flags, compliance_flags,
        repair_estimates, negotiation_intel,
        decision, decision_reasoning,
        insurance_risk_score, insurance_flags,
        crime_risk_score, solar_suitability_score,
        trades_flags, maintenance_cost_estimate,
        pdf_url, status, generation_cost_zar, times_sold
      ) VALUES (
        $1, 2850000, 2400000, 2900000, 'fair',
        $2, $3, $4,
        'MEDIUM', $5, $6,
        $7, $8,
        'NEGOTIATE', 'Asking price is at the top of the AVM range. Roof shows signs of age. Negotiate R150k off based on deferred maintenance.',
        6, $9,
        4, 8,
        $10, 85000,
        NULL, 'complete', 12.50, 0
      )
      RETURNING id
    `, [
      prop1,
      JSON.stringify([
        { address: '10 Kloof St', price: 2700000, sold_date: '2025-11-01', size_sqm: 210 },
        { address: '18 Kloof St', price: 2950000, sold_date: '2025-09-15', size_sqm: 230 }
      ]),
      JSON.stringify({
        avg_price_sqm: 12800,
        median_days_on_market: 45,
        price_trend_12m: '+3.2%',
        total_listings: 28
      }),
      JSON.stringify([
        { photo_type: 'exterior', finding: 'Hairline crack visible on north-facing gable wall', severity: 'MEDIUM', confidence: 'CONFIRMED_VISIBLE' },
        { photo_type: 'roof', finding: 'Concrete tiles showing weathering, possible moss growth', severity: 'LOW', confidence: 'PROBABLE' }
      ]),
      JSON.stringify([
        { observation: 'Hairline crack on gable wall — monitor for movement', severity: 'MEDIUM' }
      ]),
      JSON.stringify([
        { observation: 'DB board appears older model — recommend CoC check', severity: 'MEDIUM' }
      ]),
      JSON.stringify({
        total_min_zar: 45000,
        total_max_zar: 85000,
        items: [
          { category: 'roof', description: 'Moss treatment and waterproofing', min: 15000, max: 25000 },
          { category: 'walls', description: 'Crack repair and repaint gable', min: 8000, max: 15000 },
          { category: 'electrical', description: 'DB board upgrade + CoC', min: 22000, max: 45000 }
        ]
      }),
      JSON.stringify({
        days_on_market: 62,
        price_reductions: 1,
        motivated_seller_signals: ['price already reduced once', 'listing says "must sell"'],
        suggested_offer: 2700000,
        negotiation_points: ['deferred roof maintenance', 'electrical CoC needed', 'crack on gable wall']
      }),
      JSON.stringify([
        'older_roof_material',
        'structural_crack_visible',
        'electrical_compliance_unknown'
      ]),
      JSON.stringify([
        { trade_type: 'electrical', description: 'DB board upgrade and CoC', priority: 'HIGH', est_cost: 35000 },
        { trade_type: 'roofing', description: 'Moss treatment and waterproofing', priority: 'MEDIUM', est_cost: 20000 },
        { trade_type: 'painting', description: 'Gable wall crack repair and repaint', priority: 'LOW', est_cost: 12000 }
      ])
    ]);

    const reportId = reports[0].id;
    console.log(`Inserted 1 property_report: ID ${reportId}`);

    // --- 2 test orders ---
    await client.query(`
      INSERT INTO orders (property_id, report_id, phone_number, price_zar, was_resale, payment_status)
      VALUES
        ($1, $3, '+27821234567', 149, false, 'paid'),
        ($2, NULL, '+27839876543', 149, false, 'pending')
    `, [prop1, prop2, reportId]);

    console.log('Inserted 2 orders');

    await client.query('COMMIT');
    console.log('\nSeed complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = seed;

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
