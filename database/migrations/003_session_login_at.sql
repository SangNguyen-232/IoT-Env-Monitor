-- Safe to run while the backend is active, and safe to run more than once.
-- Existing sessions keep NULL: their original login time was not recorded.
-- Successful logins insert a new session; saves/touches preserve login_at.
BEGIN;

CREATE TABLE IF NOT EXISTS "session" (
  sid varchar PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS login_at timestamptz;
ALTER TABLE "session" ALTER COLUMN login_at SET DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" (expire);

COMMIT;
