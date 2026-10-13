-- DB/auth_migration.sql
-- password stores a bcrypt hash, never plaintext. Seed the first admin via ADMIN_USERNAME / ADMIN_PASSWORD.
CREATE TABLE IF NOT EXISTS system_users (
  id         SERIAL PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMP DEFAULT NOW()
);
 
CREATE TABLE IF NOT EXISTS user_devices (
  user_id   INTEGER NOT NULL REFERENCES system_users(id) ON DELETE CASCADE,
  device_id TEXT    NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
 
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'iot_user') THEN
    GRANT ALL PRIVILEGES ON TABLE system_users TO iot_user;
    GRANT USAGE, SELECT ON SEQUENCE system_users_id_seq TO iot_user;
    GRANT ALL PRIVILEGES ON TABLE user_devices TO iot_user;
  END IF;
END $$;