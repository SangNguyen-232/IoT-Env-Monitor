-- Additive and safe to run more than once. Stop the backend, back up first,
-- then apply this file before starting the upgraded backend. See MIGRATIONS.md.
-- Historical rows retain NULL metadata: no inferred model output or labels.
BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.sensor_logs
  ADD COLUMN IF NOT EXISTS boot_id text,
  ADD COLUMN IF NOT EXISTS sample_seq bigint,
  ADD COLUMN IF NOT EXISTS sampled_uptime_ms bigint,
  ADD COLUMN IF NOT EXISTS ai jsonb,
  ADD COLUMN IF NOT EXISTS fan_reason text,
  ADD COLUMN IF NOT EXISTS fan_config jsonb,
  ADD COLUMN IF NOT EXISTS fan_decision_sample_seq bigint,
  ADD COLUMN IF NOT EXISTS fan_decided_uptime_ms bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.sensor_logs'::regclass AND conname = 'sensor_logs_ai_metadata_check') THEN
    ALTER TABLE public.sensor_logs ADD CONSTRAINT sensor_logs_ai_metadata_check CHECK (
      (boot_id IS NULL OR boot_id ~ '^[A-Za-z0-9._:-]{1,64}$') AND
      (sample_seq IS NULL OR sample_seq BETWEEN 0 AND 4294967295) AND
      (sampled_uptime_ms IS NULL OR sampled_uptime_ms BETWEEN 0 AND 4294967295) AND
      (ai IS NULL OR jsonb_typeof(ai) = 'object') AND
      (fan_reason IS NULL OR fan_reason ~ '^[A-Za-z0-9._:-]{1,64}$') AND
      (fan_config IS NULL OR jsonb_typeof(fan_config) = 'object')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.sensor_logs'::regclass AND conname = 'sensor_logs_fan_decision_check') THEN
    ALTER TABLE public.sensor_logs ADD CONSTRAINT sensor_logs_fan_decision_check CHECK (
      (fan_decision_sample_seq IS NULL OR fan_decision_sample_seq BETWEEN 0 AND 4294967295) AND
      (fan_decided_uptime_ms IS NULL OR fan_decided_uptime_ms BETWEEN 0 AND 4294967295)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sensor_logs_device_id ON public.sensor_logs (device_id, id);
COMMENT ON COLUMN public.sensor_logs.ai IS
  'Raw TinyML outputs and cumulative rule agreement; neither calibrated confidence nor measured fan effectiveness.';
COMMENT ON COLUMN public.sensor_logs."Score" IS
  'Legacy textual rule-agreement field. New firmware sends NULL and uses ai.agreement_pct.';
COMMENT ON COLUMN public.sensor_logs.boot_id IS
  'Firmware boot identifier. Group with device_id and sample_seq; sensor/fan/ai events may share one sample.';
COMMENT ON COLUMN public.sensor_logs.sampled_uptime_ms IS
  'Sample acquisition millis() modulo 2^32. Use boot_id/sample_seq to reconstruct samples, not upload time.';
COMMENT ON COLUMN public.sensor_logs.fan_decision_sample_seq IS
  'Sensor sample used at the last fan controller commit; may differ from the independently captured telemetry sample.';
COMMENT ON COLUMN public.sensor_logs.fan_decided_uptime_ms IS
  'millis() modulo 2^32 at the last fan controller commit. This is not a physical fan feedback measurement.';

-- A pre-existing display view is explicitly column-bound; append the new
-- columns while preserving its timestamp formatting and read-only behavior.
DO $$
DECLARE
  display_columns text;
BEGIN
  IF to_regclass('display.sensor_logs') IS NOT NULL THEN
    SELECT string_agg(
      CASE WHEN data_type = 'timestamp with time zone' THEN
        format($fmt$to_char(%I AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') AS %I$fmt$, column_name, column_name)
      WHEN data_type = 'timestamp without time zone' THEN
        format($fmt$to_char(%I, 'YYYY-MM-DD HH24:MI:SS') AS %I$fmt$, column_name, column_name)
      ELSE format('%I', column_name) END, ', ' ORDER BY ordinal_position
    ) INTO display_columns
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sensor_logs';
    EXECUTE format(
      'CREATE OR REPLACE VIEW display.sensor_logs WITH (security_invoker = true) AS SELECT %s FROM public.sensor_logs OFFSET 0',
      display_columns
    );
  END IF;
END $$;
COMMIT;
