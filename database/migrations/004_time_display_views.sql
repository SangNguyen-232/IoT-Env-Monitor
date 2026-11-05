-- Run after the backend has initialized all five public tables (including login_at).
-- Display timestamps in Vietnam time without changing stored types or precision.
-- session.expire is a local timestamp written in the project's UTC+7 DB timezone.
-- latency and cookie.originalMaxAge are durations and must remain numeric.
BEGIN;

CREATE SCHEMA IF NOT EXISTS display;
COMMENT ON SCHEMA display IS
  'Read-only views: Vietnam time, YYYY-MM-DD HH24:MI:SS. Applications write to public.';

DO $$
DECLARE
  source_table text;
  display_columns text;
BEGIN
  FOREACH source_table IN ARRAY ARRAY[
    'sensor_logs', 'device_credentials', 'system_users', 'user_devices', 'session'
  ] LOOP
    SELECT string_agg(
      CASE
        WHEN c.data_type = 'timestamp with time zone' THEN
          format($fmt$to_char(%I AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') AS %I$fmt$,
            c.column_name, c.column_name)
        WHEN c.data_type = 'timestamp without time zone' THEN
          format($fmt$to_char(%I, 'YYYY-MM-DD HH24:MI:SS') AS %I$fmt$,
            c.column_name, c.column_name)
        WHEN source_table = 'session' AND c.column_name = 'sess' THEN
          $expr$CASE
            WHEN jsonb_typeof(sess::jsonb #> '{cookie,expires}') = 'string' THEN
              jsonb_set(sess::jsonb, '{cookie,expires}', to_jsonb(to_char(
                (sess #>> '{cookie,expires}')::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh',
                'YYYY-MM-DD HH24:MI:SS'
              )))::json
            ELSE sess
          END AS sess$expr$
        ELSE format('%I', c.column_name)
      END,
      ', ' ORDER BY c.ordinal_position
    ) INTO display_columns
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = source_table;

    IF display_columns IS NULL THEN
      RAISE EXCEPTION 'Missing public table %. Start the backend before running this migration.', source_table;
    END IF;

    -- OFFSET makes every view read-only; permissions still use the caller's rights.
    EXECUTE format(
      'CREATE OR REPLACE VIEW display.%I WITH (security_invoker = true) AS SELECT %s FROM public.%I OFFSET 0',
      source_table, display_columns, source_table
    );
  END LOOP;
END $$;

COMMIT;
