# PostgreSQL migrations and telemetry history

The project uses PostgreSQL 18 (`iot_postgres`, image `postgres:18.6-alpine3.24`), executed inside a **Linux Ubuntu virtual machine** via Docker Compose alongside `iot_backend` (Express 5) and `iot_cloudflared` (`cloudflare/cloudflared:2026.10.1`). **PostgreSQL itself is never exposed onto Cloudflare Tunnel or Workers VPC**: Compose mounts the named volume `fan_pgdata18` at `/var/lib/postgresql`, keeps port `5432` internal to `iot_net` for `iot_backend`, and publishes `127.0.0.1:5433->5432/tcp` strictly on the Ubuntu VM's local loopback for maintenance. Only `iot_backend` (`http://backend:3000`) is bridged outbound through `iot_cloudflared` (tunnel `iot-env-monitor-sys`, `1 VPC` route) to Cloudflare **Workers VPC** (`iot-env-backend`) and Cloudflare Workers (`*.workers.dev`), so remote ESP32 `POST /sensor` writes and `/admin/api/history` queries reach PostgreSQL exclusively through Express.

The PostgreSQL image runs initialization scripts only when the data directory is empty. Subsequent backend builds reuse the existing database. Keep the volume when stopping or upgrading the stack on the Ubuntu VM; the Compose `down -v` option removes it. [Project setup](../GUIDE.md) · [Compose configuration](../docker-compose.yml)

## Fresh database initialization

Compose runs the following scripts in order on first initialization inside the Linux Ubuntu VM.

1. [Base schema](schema/base.sql) creates the telemetry and device credential tables and their indexes.
2. [001 — authentication](migrations/001_auth.sql) creates system users and per-device access grants.
3. [003 — sessions](migrations/003_session_login_at.sql) creates the session table and gives new sessions a login timestamp.
4. [004 — display views](migrations/004_time_display_views.sql) creates read-only views of the five public tables. These format timestamps in the project's Vietnam time zone for display. Applications write to the public tables.
5. [005 — AI telemetry](migrations/005_ai_telemetry.sql) ensures the experiment columns, constraints and history pagination index exist and refreshes the existing telemetry display view.

[002 — legacy time zones](migrations/002_timezone.sql) is for older databases with timestamps stored without a time zone. It interprets the two legacy sensor timestamps as `Asia/Ho_Chi_Minh` and the user creation timestamp as UTC. The fresh schema already uses `timestamptz` for those fields. Verify the source time zone before using this conversion on imported data.

## Upgrade an existing database

The procedure below runs locally inside the **Linux Ubuntu virtual machine** on a project database that already has the baseline tables and is missing AI telemetry metadata. For earlier installations, first inspect the live schema against the prerequisites above and back up before applying any missing steps. The backend checks the names of the required `sensor_logs` columns at startup. A reported missing column can therefore belong to the baseline or to migration 005.

**1. Pause writes.** Run `docker compose ps` (or `docker-compose ps`) from the repository root inside the Linux Ubuntu VM to inspect `iot_postgres`, `iot_backend`, and `iot_cloudflared`. For the containerized deployment, run `docker compose stop backend` (this temporarily stops Express behind Workers VPC / `iot_cloudflared` while keeping `iot_postgres` running locally). For a backend running directly on the Ubuntu VM host, stop that Node process. Pause other local clients on `127.0.0.1:5433` writing to this database during the upgrade. This also pauses the backend's scheduled retention job.

**2. Back up the database and apply migration 005.** Run the following Bash block locally inside the Linux Ubuntu VM. It keeps the archive outside the repository in a private directory under `$HOME`, prints the directory path, and stops at the first failing command. The archive can contain account data, login sessions and telemetry. Keep a copy on durable private storage.

```bash
(
  set -eu
  umask 077
  backup_dir=$(mktemp -d "$HOME/iot-ai-backup.XXXXXXXX")
  echo "Backup directory: $backup_dir"
  docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_dir/before-ai.dump"
  docker compose exec -T postgres pg_restore --list < "$backup_dir/before-ai.dump" > "$backup_dir/contents.txt"
  docker compose exec -T postgres sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < database/migrations/005_ai_telemetry.sql
)
```

`pg_restore --list` checks that the archive directory is readable. To exercise recovery on the Ubuntu VM, restore the dump into a new empty database on a separate PostgreSQL 18 test instance. For example, in an Ubuntu shell configured with the test instance's `PGHOST`, `PGPORT` and `PGUSER`, set `BACKUP_FILE` to the absolute path of the saved dump. The PostgreSQL client commands below stop if the test database name is already in use. The restore checks schema and data under the test role and skips ownership and grants. For a full recovery with original permissions, also provision the original roles and restore their ownership and grants.

```bash
(
  set -eu
  : "${PGHOST:?Set PGHOST to the separate test instance}"
  : "${PGPORT:?Set PGPORT for that instance}"
  : "${PGUSER:?Set PGUSER to a role that can create a test database}"
  : "${BACKUP_FILE:?Set BACKUP_FILE to the saved dump path}"
  createdb --template=template0 iot_restore_check
  pg_restore --exit-on-error --no-owner --no-privileges --dbname=iot_restore_check "$BACKUP_FILE"
  psql -X -v ON_ERROR_STOP=1 -d iot_restore_check -c 'SELECT count(*) AS telemetry_rows FROM public.sensor_logs'
)
```

Compare the restored count and representative records with the source at backup time. The test database remains available for inspection. The archive covers this database's schema and data. PostgreSQL cluster roles and their passwords require separate recovery arrangements.

**3. Verify the upgrade and resume the original backend.** Migration 005 adds eight nullable columns, enforces range and shape constraints, and creates the `(device_id, id)` index. Existing rows keep NULL for newly added fields. Its transaction has a ten-second lock timeout and can be rerun after a blocking transaction finishes. Run the following read-only query inside the Linux Ubuntu VM and expect `sensor_logs_ai_metadata_check` and `sensor_logs_fan_decision_check` to be listed as validated.

```bash
docker compose exec -T postgres sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT conname, convalidated
FROM pg_constraint
WHERE conrelid = 'public.sensor_logs'::regclass
  AND conname IN ('sensor_logs_ai_metadata_check', 'sensor_logs_fan_decision_check')
ORDER BY conname;
SQL
```

For the containerized stack on the Ubuntu VM, run `docker compose up -d --build --wait backend cloudflared`, inspect `docker compose logs --tail=80 backend`, and verify `/healthz` both inside `iot_backend` and via your `https://<worker>.<subdomain>.workers.dev/healthz` Cloudflare Worker URL. For the host-Node test route on the Ubuntu VM, restart Node from the setup guide and open `/healthz` on its listening port. The expected result is HTTP 200 and `{"ok":true}`. The startup retention sweep can remove old rows immediately. Set the intended retention period before restarting. [Backend setup and health checks](../GUIDE.md)

## Reading telemetry

- **Acquisition and arrival.** Use `device_id`, `boot_id` and `sample_seq` to group events for one sensor reading. Several `sensor`, `ai` and `fan` rows can share the same acquisition. The field `sampled_uptime_ms` is the acquisition time from the board's 32-bit millisecond clock and wraps after about 49.7 days. With a synchronized clock, `timestamp_real` records sampling time in UTC. The board sets `timestamp_up` when preparing the payload. The backend assigns `received_at` on insert. Queuing and retries across Wi-Fi or the Cloudflare Worker + VPC + Tunnel link can separate these three times.
- **Model output.** The `ai` JSONB object includes the model version, status, sample identity and inference duration. A ready prediction has temperature and humidity slopes per minute, residual jitter, the fan command at acquisition, the predicted and current reference classes, and INT8 softmax scores in OFF, HOLD, ON order. Scores have 1/256 resolution and can sum to slightly more or less than one. The current firmware needs seven consecutive in-domain samples. A ready result must match the top-level `sample_seq` and `sampled_uptime_ms`. Non-ready results carry null predictions, scores, slopes, jitter and sampled fan command. Their sample identifiers can describe an earlier evaluation.
- **Agreement.** The legacy `"Score"` column receives NULL from current firmware. The field `ai.agreement_pct` compares the proposal with the **current** reference band over `ai.evaluated_samples` predictions since boot. The forecast target is the band 30 seconds later. A comparison with measured future readings uses the offline session import workflow on the Linux Ubuntu VM. [Model contract and history import](../ml/README.md)
- **Fan decisions.** `"MODE_state"` records AUTO, SHADOW, AI or MANUAL. `"FAN_state"`, `fan_reason` and `fan_config` describe the applied GPIO command, decision reason and thresholds used at that decision. `fan_decision_sample_seq` and `fan_decided_uptime_ms` identify the controller's sample and decision time. Because acquisition and actuation use separate locks, the decision sequence can differ from the rest of the row. Physical fan motion requires a separate observation.
- **Gaps and retention.** Multiple pending events can coalesce, and the six-payload RAM queue drops its oldest payload when full. Check sequences and uptimes before reconstructing a continuous series. The backend purges rows using `COALESCE(received_at, timestamp_up)` at startup and every six hours. `SENSOR_RETENTION_DAYS` defaults to 30. A value of 0 disables automatic deletion. Changing the setting affects future sweeps.

## Exporting history

Sign in to `/admin/` (via the deployed `https://<worker>.<subdomain>.workers.dev` Cloudflare Worker gateway or locally on `localhost:3000` during Ubuntu VM tests), set the optional **History export range** in the browser's local time, then select **Export JSONL** on the device card. The dashboard requests up to 1,000 rows per page, includes the LAN IP when present and writes one JSON object per event. Old rows keep their original null fields. The dashboard can cancel an export before download.

For an API client using the same login session against the `*.workers.dev` gateway or local Ubuntu VM backend, begin with a request such as the following. Replace `guide-demo` with the device ID you want to export.

```text
GET /admin/api/history?device_id=guide-demo&limit=500
```

- The response contains `rows`, `next_after_id` and `until_id`. Rows are in ascending database ID order. The default limit is 500, with an allowed range of 1 through 1,000.
- On later pages, keep the device, filters and original `until_id`, and pass the returned `next_after_id` as `after_id`. A null `next_after_id` ends the export. A positive `after_id` requires an `until_id`.
- Optional filters are `lan_ip`, `from` (inclusive) and `to` (exclusive). The time filters use the same receipt-time expression as retention. Supply an ISO timestamp with seconds and a zone, such as `2026-01-01T08:00:00Z`. Encode a plus sign in a numeric UTC offset as `%2B`.
- Admins can access all devices. Users see rows authorized by their device and LAN-IP grants. A grant with an empty LAN IP covers that device across addresses. Omitting the IP filter still enforces these grants.
- The first response fixes a maximum row ID so ordinary subsequent inserts do not extend the export. Concurrent deletions, retention and late-committing inserts can still affect later pages. Use a local `pg_dump` backup on the Ubuntu VM for a transaction-consistent archive.
