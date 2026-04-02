-- SUREPATH DATABASE SCHEMA v2.0
-- B2B ecosystem model — all segments supported from launch

CREATE TYPE report_status AS ENUM ('pending','processing','complete','failed','resold');
CREATE TYPE decision_type AS ENUM ('BUY','NEGOTIATE','INSPECT_FIRST','WALK_AWAY');
CREATE TYPE risk_level AS ENUM ('CRITICAL','HIGH','MEDIUM','LOW','NEGLIGIBLE');
CREATE TYPE content_status AS ENUM ('draft','approved','scheduled','posted');
CREATE TYPE api_tier AS ENUM ('consumer','insurance','security','trades','solar','enterprise');

CREATE TABLE properties (
  id SERIAL PRIMARY KEY,
  erf_number TEXT UNIQUE NOT NULL,
  address_raw TEXT NOT NULL,
  address_normalised TEXT,
  suburb TEXT, city TEXT, province TEXT,
  lat DECIMAL(10,7), lng DECIMAL(10,7),
  property_type TEXT,
  stand_size_sqm INTEGER, floor_area_sqm INTEGER,
  bedrooms INTEGER, bathrooms INTEGER,
  construction_era TEXT,
  solar_installed BOOLEAN,
  security_visible BOOLEAN,
  roof_material TEXT,
  roof_orientation TEXT,
  suburb_crime_score INTEGER,
  last_deeds_lookup TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE deeds_data (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  registered_owner TEXT, title_deed_ref TEXT,
  municipal_value INTEGER,
  transfer_history JSONB,
  raw_windeed_response JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE property_reports (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  asking_price INTEGER,
  avm_low INTEGER, avm_high INTEGER,
  price_verdict TEXT,
  comparables JSONB,
  suburb_intelligence JSONB,
  vision_findings JSONB,
  asbestos_risk risk_level,
  structural_flags JSONB,
  compliance_flags JSONB,
  repair_estimates JSONB,
  negotiation_intel JSONB,
  decision decision_type NOT NULL,
  decision_reasoning TEXT NOT NULL,
  insurance_risk_score INTEGER,
  insurance_flags JSONB,
  crime_risk_score INTEGER,
  solar_suitability_score INTEGER,
  trades_flags JSONB,
  maintenance_cost_estimate INTEGER,
  pdf_url TEXT,
  status report_status NOT NULL DEFAULT 'pending',
  generation_cost_zar DECIMAL(8,2),
  times_sold INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_refreshed_at TIMESTAMPTZ
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  report_id INTEGER REFERENCES property_reports(id),
  phone_number TEXT NOT NULL,
  price_zar INTEGER NOT NULL DEFAULT 149,
  was_resale BOOLEAN NOT NULL DEFAULT FALSE,
  payfast_payment_id TEXT,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  report_delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE property_images (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  source TEXT NOT NULL,
  image_url TEXT NOT NULL,
  image_type TEXT,
  vision_analysis JSONB,
  analysed_at TIMESTAMPTZ
);

CREATE TABLE content_posts (
  id SERIAL PRIMARY KEY,
  pillar TEXT NOT NULL,
  hook TEXT NOT NULL, script TEXT, cta TEXT NOT NULL,
  audio_url TEXT, avatar_video_url TEXT, final_video_url TEXT,
  status content_status NOT NULL DEFAULT 'draft',
  instagram_post_id TEXT, tiktok_post_id TEXT, youtube_post_id TEXT,
  scheduled_for TIMESTAMPTZ, posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE api_clients (
  id SERIAL PRIMARY KEY,
  company_name TEXT NOT NULL,
  tier api_tier NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  rate_limit_per_day INTEGER NOT NULL DEFAULT 1000,
  price_per_query_zar DECIMAL(8,2),
  contract_start DATE, contract_end DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE api_usage (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES api_clients(id),
  property_id INTEGER REFERENCES properties(id),
  endpoint TEXT NOT NULL,
  was_cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
  response_time_ms INTEGER,
  billed_amount_zar DECIMAL(8,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE crime_incidents (
  id SERIAL PRIMARY KEY,
  suburb TEXT NOT NULL, city TEXT NOT NULL,
  lat DECIMAL(10,7), lng DECIMAL(10,7),
  incident_type TEXT NOT NULL,
  incident_date DATE NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE trades_jobs (
  id SERIAL PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id),
  trade_type TEXT NOT NULL,
  job_description TEXT,
  approximate_cost_zar INTEGER,
  job_date DATE,
  source_company TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_properties_erf ON properties(erf_number);
CREATE INDEX idx_properties_suburb ON properties(suburb, city);
CREATE INDEX idx_reports_property ON property_reports(property_id);
CREATE INDEX idx_reports_insurance ON property_reports(insurance_risk_score);
CREATE INDEX idx_reports_solar ON property_reports(solar_suitability_score);
CREATE INDEX idx_orders_phone ON orders(phone_number);
CREATE INDEX idx_crime_suburb ON crime_incidents(suburb, city, incident_date);
CREATE INDEX idx_trades_property ON trades_jobs(property_id, trade_type);
CREATE INDEX idx_api_usage_client ON api_usage(client_id, created_at);
