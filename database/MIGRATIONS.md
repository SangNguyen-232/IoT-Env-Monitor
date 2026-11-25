# Upgrading AI Telemetry Without Losing Historical Data

Docker only executes scripts mounted under `/docker-entrypoint-initdb.d` when initializing an empty PostgreSQL volume. Rebuilding the backend image does **not** automatically apply schema migrations to an existing data volume. Never run `docker compose down -v` during an upgrade, because `-v` permanently deletes the PostgreSQL volume.

## Upgrading an Existing Database Volume

Run the commands below from the repository root after verifying the active PostgreSQL container and preparing durable storage for your backup. These commands use the container's configured PostgreSQL environment variables so database credentials are not exposed on the host command line:

```bash
# Stop backend writes and scheduled retention cleanup during backup and migration.
docker compose stop backend
backup_dir=$(mktemp -d /tmp/iot-ai-backup.XXXXXX)
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_dir/before-ai.dump"
# Verify that the archive table of contents is readable, then copy it to durable storage.
docker compose exec -T postgres pg_restore --list < "$backup_dir/before-ai.dump"
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < database/migrations/005_ai_telemetry.sql
docker compose up -d --build backend
docker compose logs --tail=80 backend
```

Migrations `001` through `004` belong to the baseline schema stack:

- If upgrading from an older installation, inspect the live schema and the header comments inside each migration file before applying them in numerical order.
- Migration `002_timezone.sql` converts legacy `timestamp without time zone` columns using explicit source time zones (`Asia/Ho_Chi_Minh` for `sensor_logs`, `UTC` for `system_users.created_at`); do not assume time zones for external data imported outside this project.
- Migration `005_ai_telemetry.sql` runs inside a transaction with `lock_timeout = '10s'`, adds nullable experiment metadata columns, validates constraints, creates `idx_sensor_logs_device_id`, and refreshes `display.sensor_logs` without backfilling synthetic labels onto historical rows.
- `005_ai_telemetry.sql` is idempotent and safe to re-run. If `lock_timeout` expires, the transaction rolls back cleanly and can be re-executed once blocking queries finish. Index creation and constraint validation may take longer on large tables.
- At startup (`ensureSchema()`), the backend verifies that every required `sensor_logs` column exists and exits with an actionable migration message if any column is missing.
- Rolling back to an older backend binary leaves the additive nullable columns harmlessly in place; however, new ESP32 firmware requires the upgraded backend to ingest AI metadata fields.

## Fresh Database Initialization

On a brand-new environment with no existing `fan_pgdata18` volume, running `docker compose up -d --build` automatically executes `database/schema/base.sql` followed by `001_auth.sql`, `003_session_login_at.sql`, `004_time_display_views.sql`, and `005_ai_telemetry.sql`. This initialization sequence applies **only** to empty volumes and does not replace the existing-volume upgrade procedure above.

## Experiment Telemetry & History Export Contract

- The current firmware sends `null` for the legacy `Score` column. In the predictive firmware, `ai.rule_class` is the action given by the instantaneous model profile (30/28°C, 75/70% RH, OR). `ai.agreement_pct` counts how often the proposal matches that instantaneous action among the `evaluated_samples` since boot. A proactive ON in the hysteresis band intentionally disagrees with HOLD. Forecast accuracy requires observing a future outcome.
- The `ai` JSONB field stores the model version, status, proposal, rule class, inference time and raw class scores in `[OFF, HOLD, ON]` order. INT8 softmax outputs are multiples of 1/256. Quantization and saturation can make the sum differ slightly from one. The controller checks the winning raw score against 0.80.
- Predictive firmware also reports `window_samples` and `window_capacity` (7). A ready result includes `temp_slope_c_min`, `humi_slope_pct_min` (percentage points of RH per minute), `residual_jitter` (dimensionless combined RMS deviation from the fitted temperature and humidity trends, scaled by the 2°C and 5% RH hysteresis widths), and `fan_on_at_sample` (boolean GPIO command recorded at acquisition, before this sample drives a new decision). These four features are null when a result is unavailable. In particular, `warming_up` reports the accumulated count without publishing a prediction. Historical JSON without the predictive fields remains readable. Sites that have applied migration 005 only need the updated backend to accept these JSON keys.
- **Sample matching**: When `ai.status` is `"ready"`, top-level `sample_seq` and `sampled_uptime_ms` must be present and strictly match `ai.sample_seq` and `ai.sampled_uptime_ms`. Non-ready statuses may retain the previous evaluated sample's identifiers while clearing `predicted_class` and `probabilities` to `null`.
- **`boot_id`, `sample_seq`, and `sampled_uptime_ms`**: Uniquely identify each sensor acquisition within a single firmware boot session. `sampled_uptime_ms` is a 32-bit `millis()` timestamp that wraps every ~49.7 days. Multiple `sensor`, `fan`, and `ai` telemetry events may reference the same sample.
- **`received_at` and `timestamp_up`**: Record backend ingestion time and device HTTP upload time, respectively. Do not treat either column as the sensor acquisition timestamp during offline time-series analysis.
- **`fan_reason` and `fan_config`**: `fan_reason` records the controller's decision code; `fan_config` captures the exact threshold snapshot consumed by `task_fan` for that decision, even if a newly saved dashboard configuration is waiting for the next control cycle. `"MODE_state"` accepts `AUTO`, `SHADOW`, `AI`, or `MANUAL`.
- **`fan_decision_sample_seq` and `fan_decided_uptime_ms`**: Identify the sensor sample sequence and 32-bit `millis()` timestamp at the most recent fan controller commit. Because sensor/AI state (`mutexContext`) and actuator state (`xMutexFanControl`) are read under separate locks, `fan_decision_sample_seq` can differ from the telemetry row's `sample_seq`. These fields trace software GPIO commands, not tachometer rotation or physical cooling performance. Legacy rows store `null`.
- **Best-effort transport**: Pending event flags can coalesce while HTTP requests block, and the ESP32 RAM queue (`POST_QUEUE_MAX = 6`) drops the oldest entry when full. Complete capture of every inference or relay transition is not guaranteed. When constructing forecasting windows offline, inspect `boot_id`, `sample_seq`, and `sampled_uptime_ms` to exclude sequence gaps rather than inferring actuation timing from server arrival order.
- **Retention (`SENSOR_RETENTION_DAYS`)**: Defaults to `30` days, purging expired rows at backend startup and every 6 hours. Set `SENSOR_RETENTION_DAYS=0` to disable automatic deletion during extended lab collection runs, monitor disk usage, and export/back up datasets proactively. Changing `SENSOR_RETENTION_DAYS` cannot recover already-purged rows.

### Paginated History Endpoint (`GET /admin/api/history`)

Authenticated endpoint:

```text
GET /admin/api/history?device_id=<DEVICE_ID>&limit=1000
```

- **Optional filters**: `lan_ip`, `from` (inclusive), and `to` (exclusive). Timestamps must be valid ISO 8601 strings with `Z` or an explicit UTC offset (for example, `2026-11-11T08:00:00%2B07:00`). Time filters apply to `COALESCE(received_at, timestamp_up)`.
- **Cursor pagination**: `limit` accepts `1..1000` (default `500`). Responses have the shape `{ rows, next_after_id, until_id }` ordered by ascending `id`.
- When `next_after_id` is non-null, request the next page using the same filter parameters plus `after_id=<next_after_id>&until_id=<until_id>`. Pagination terminates when `next_after_id` is `null`.
- **`until_id` high-water mark**: Bounds the export so ordinary new inserts do not extend an in-progress export indefinitely. It is **not** an immutable MVCC snapshot: concurrent deletions, retention purges, or late-committing transactions can still affect visible rows. For a strictly immutable archive, stop writes/retention before exporting or take a `pg_dump` backup.
- **Access control & legacy rows**: RBAC grants (`system_users` / `user_devices`) are enforced per account, `device_id`, and `lan_ip`. Legacy rows lacking AI metadata retain `null` fields and are never synthesized into AI samples.
