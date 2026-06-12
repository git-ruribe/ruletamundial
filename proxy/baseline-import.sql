-- FlagCounter (info.flagcounter.com/hwP4) legacy import — snapshot 2026-06-12.
-- Run once in the D1 console of the `gonnafind` database. Idempotent: safe to
-- re-run; re-running with newer numbers overwrites the old baseline.
-- 22 countries, 193 visitors total. /t/stats merges these into all-time counts.

CREATE TABLE IF NOT EXISTS baseline (
  country TEXT PRIMARY KEY,
  n       INTEGER NOT NULL
);

INSERT OR REPLACE INTO baseline (country, n) VALUES
  ('MX', 79),
  ('US', 51),
  ('GB', 13),
  ('ES', 7),
  ('NL', 7),
  ('CH', 5),
  ('FR', 4),
  ('BE', 4),
  ('BR', 4),
  ('SG', 3),
  ('IT', 2),
  ('NZ', 2),
  ('CA', 2),
  ('DE', 2),
  ('AU', 1),
  ('HU', 1),
  ('CO', 1),
  ('PL', 1),
  ('IN', 1),
  ('SE', 1),
  ('AR', 1),
  ('KE', 1);
