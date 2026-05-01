CREATE TABLE IF NOT EXISTS public.inbound_leads (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  name TEXT,
  email TEXT,
  budget TEXT,
  timeline TEXT,
  transcript TEXT,
  source TEXT NOT NULL,
  downloaded BOOLEAN NOT NULL DEFAULT FALSE
);
