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
  srt_content TEXT, srt_url TEXT, property_id INTEGER, downloaded_at TIMESTAMPTZ,
  status content_status NOT NULL DEFAULT 'draft',
  instagram_post_id TEXT, tiktok_post_id TEXT, youtube_post_id TEXT,
  scheduled_for TIMESTAMPTZ, posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE trending_hashtags (
  id SERIAL PRIMARY KEY,
  tag TEXT UNIQUE NOT NULL,
  category TEXT,
  rank INTEGER,
  score NUMERIC,
  post_count BIGINT,
  source TEXT NOT NULL DEFAULT 'curated',
  region TEXT DEFAULT 'ZA',
  active BOOLEAN DEFAULT TRUE,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_trending_hashtags_active_rank ON trending_hashtags(active, rank) WHERE active = TRUE;
CREATE INDEX idx_trending_hashtags_category ON trending_hashtags(category);

CREATE TABLE tiktok_accounts (
  id SERIAL PRIMARY KEY,
  open_id TEXT UNIQUE NOT NULL,
  union_id TEXT,
  display_name TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  scope TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE stock_footage (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'pexels',
  source_id TEXT NOT NULL,
  media_type TEXT DEFAULT 'video',
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  preview_url TEXT,
  s3_key TEXT,
  trimmed BOOLEAN DEFAULT FALSE,
  duration_seconds NUMERIC,
  width INTEGER,
  height INTEGER,
  category TEXT,
  keyword TEXT,
  tags JSONB,
  description TEXT,
  photographer TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source, source_id)
);
CREATE INDEX idx_stock_footage_category ON stock_footage(category);
CREATE INDEX idx_stock_footage_keyword ON stock_footage(keyword);

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
