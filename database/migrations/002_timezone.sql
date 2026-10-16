-- Run with the backend stopped. Already-converted columns are left unchanged:
-- psql -v ON_ERROR_STOP=1 -U <user> -d <database> -f database/migrations/002_timezone.sql
-- Sensor timestamps are local ESP32 times (UTC+7).
-- Legacy created_at values were written by NOW() in a UTC database session.
BEGIN;

DO $$
DECLARE
  item record;
  column_type text;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('sensor_logs', 'timestamp_real', 'Asia/Ho_Chi_Minh'),
    ('sensor_logs', 'timestamp_up', 'Asia/Ho_Chi_Minh'),
    ('system_users', 'created_at', 'UTC')
  ) AS columns_to_convert(table_name, column_name, source_zone)
  LOOP
    SELECT data_type INTO column_type FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = item.table_name AND column_name = item.column_name;
    IF column_type = 'timestamp without time zone' THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE %L',
        item.table_name, item.column_name, item.column_name, item.source_zone);
    ELSIF column_type IS DISTINCT FROM 'timestamp with time zone' THEN
      RAISE EXCEPTION 'Unexpected or missing timestamp column %.%: %',
        item.table_name, item.column_name, column_type;
    END IF;
  END LOOP;
END $$;

COMMIT;
