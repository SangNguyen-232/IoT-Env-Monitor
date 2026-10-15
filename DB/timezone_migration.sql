-- Run once on an existing database, with the backend stopped:
-- psql -v ON_ERROR_STOP=1 -U <user> -d <database> -f DB/timezone_migration.sql
-- Sensor timestamps are local ESP32 times (UTC+7).
-- Legacy created_at values were written by NOW() in a UTC database session.
-- Do not rerun after the columns have been converted to timestamptz.
BEGIN;

ALTER TABLE sensor_logs
  ALTER COLUMN timestamp_real TYPE timestamptz USING timestamp_real AT TIME ZONE 'Asia/Ho_Chi_Minh',
  ALTER COLUMN timestamp_up   TYPE timestamptz USING timestamp_up   AT TIME ZONE 'Asia/Ho_Chi_Minh';

ALTER TABLE system_users
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';

COMMIT;
