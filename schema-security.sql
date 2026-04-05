-- SECURITY & COMMUNITY INTELLIGENCE SCHEMA
-- Extends the core schema with tables for security companies,
-- SAPS precincts/CPFs, and neighbourhood watches.

-- ─── SAPS Precincts (police stations + CPFs) ─────────────────────────
CREATE TABLE IF NOT EXISTS saps_precincts (
  id SERIAL PRIMARY KEY,
  station_name TEXT NOT NULL,
  saps_id INTEGER UNIQUE,              -- ID from SAPS website
  address TEXT,
  phone TEXT,
  email TEXT,
  lat DECIMAL(10,7),
  lng DECIMAL(10,7),
  province TEXT,
  cluster TEXT,                         -- SAPS cluster grouping
  commander_name TEXT,
  commander_phone TEXT,
  cpf_chair_name TEXT,
  cpf_chair_phone TEXT,
  cpf_facebook_url TEXT,
  cpf_website_url TEXT,
  cpf_activity_score INTEGER,           -- 0-100, derived from signals
  scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Security Companies ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS security_companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,                     -- URL-safe name for dedup
  psira_number TEXT,
  psira_verified BOOLEAN DEFAULT FALSE,
  website TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  province TEXT,
  google_place_id TEXT,
  google_rating DECIMAL(2,1),
  google_review_count INTEGER,
  company_size TEXT,                    -- national, regional, local
  armed_response BOOLEAN DEFAULT FALSE,
  services JSONB,                       -- ['armed_response','cctv','guarding','monitoring']
  scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Security Company ↔ Suburb coverage (many-to-many) ──────────────
CREATE TABLE IF NOT EXISTS suburb_security_coverage (
  id SERIAL PRIMARY KEY,
  suburb TEXT NOT NULL,
  city TEXT,
  province TEXT,
  security_company_id INTEGER NOT NULL REFERENCES security_companies(id),
  source TEXT NOT NULL,                 -- assist247, procompare, company_website, google_places
  source_url TEXT,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(suburb, city, security_company_id, source)
);

-- ─── Neighbourhood Watches ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS neighbourhood_watches (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  suburb TEXT,
  city TEXT,
  province TEXT,
  saps_precinct_id INTEGER REFERENCES saps_precincts(id),
  source TEXT NOT NULL,                 -- wc_gazette, afriforum, facebook, manual
  source_url TEXT,
  facebook_page_url TEXT,
  facebook_member_count INTEGER,
  facebook_post_frequency TEXT,         -- daily, weekly, monthly, inactive
  website_url TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  accredited BOOLEAN DEFAULT FALSE,
  accrediting_body TEXT,
  activity_score INTEGER,               -- 0-100, derived from signals
  last_verified TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(name, suburb, city)
);

-- ─── Suburb ↔ Precinct mapping ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS suburb_precinct_map (
  id SERIAL PRIMARY KEY,
  suburb TEXT NOT NULL,
  city TEXT,
  province TEXT,
  saps_precinct_id INTEGER NOT NULL REFERENCES saps_precincts(id),
  source TEXT NOT NULL,                 -- saps_shapefile, safesuburb, manual
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(suburb, city, saps_precinct_id)
);

-- ─── Indexes ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_saps_station_name ON saps_precincts(station_name);
CREATE INDEX IF NOT EXISTS idx_saps_province ON saps_precincts(province);
CREATE INDEX IF NOT EXISTS idx_security_co_name ON security_companies(name);
CREATE INDEX IF NOT EXISTS idx_security_co_slug ON security_companies(slug);
CREATE INDEX IF NOT EXISTS idx_suburb_coverage_suburb ON suburb_security_coverage(suburb, city);
CREATE INDEX IF NOT EXISTS idx_suburb_coverage_company ON suburb_security_coverage(security_company_id);
CREATE INDEX IF NOT EXISTS idx_nhw_suburb ON neighbourhood_watches(suburb, city);
CREATE INDEX IF NOT EXISTS idx_suburb_precinct ON suburb_precinct_map(suburb, city);
