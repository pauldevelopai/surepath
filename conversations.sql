-- WhatsApp conversation state machine
-- Separate from orders to keep schema clean

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  phone_number TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL DEFAULT 'awaiting_property',
  input_data TEXT,           -- Property24 URL or address
  photo_urls JSONB,          -- array of media URLs from Twilio
  asking_price INTEGER,
  order_id INTEGER REFERENCES orders(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone_number);
