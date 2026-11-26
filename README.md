# ESP32-S3 Air Monitoring & Fan Control System

A Yolo Uno ESP32-S3 samples air temperature and humidity every five seconds. It displays readings locally, drives a ventilation fan and can forecast which temperature/humidity band will be reached in 30 seconds. A separate soil-moisture input is available for monitoring. Real-time sensing, TinyML inference, relay actuation and the embedded device web server run locally on the board, while a containerized Node.js/Express service and PostgreSQL 18 database inside a **Linux Ubuntu virtual machine** provide multi-device monitoring, RBAC and history—with **only** the Express backend HTTP origin exposed remotely via **Cloudflare Workers + Workers VPC + Cloudflare Tunnel**.

> **Linux Ubuntu VM & Selective Cloudflare Deployment Scope:** All coding, building, execution, TinyML model training, USB firmware flashing, hardware-in-the-loop (HIL) testing, and container/Wrangler orchestration were carried out inside a **Linux Ubuntu virtual machine** (`sang@Linux`, Ubuntu LTS guest VM, branch `project_linux`). **Not the entire project is deployed onto Cloudflare Tunnel**—only the containerized Express backend (`iot_backend:3000`) is bridged privately by `iot_cloudflared` (tunnel `iot-env-monitor-sys`, `1 VPC` route only) to Cloudflare **Workers VPC** (`iot-env-backend`), fronted publicly on `*.workers.dev` by Cloudflare Workers (`services/gateway/`). Firmware, on-device TinyML, the ESP32's LAN dashboard/WebSocket/OTA, PostgreSQL (`127.0.0.1:5433`), offline Python ML training, and USB tools are **not** deployed onto Cloudflare Tunnel.

- **Start here** to set up the Linux Ubuntu VM toolchain, test the backend locally, compile and flash the two ESP32 images over VM USB passthrough, and deploy the Express backend + Cloudflare Worker VPC gateway. [Getting started](GUIDE.md)
- **Work with sensor data** locally in Python 3.12 on the Linux Ubuntu VM to interpret the model, train and quantize a candidate for ESP32 firmware, or import JSONL history exported from `/admin/`. [TinyML model and training](ml/README.md)
- **Verify a physical setup** locally over Wi-Fi LAN and Ubuntu VM USB Serial passthrough (`/dev/ttyACM0`), with optional telemetry recording through the Cloudflare Worker VPC gateway. [Bench guide](ml/HIL.md)
- **Upgrade an existing installation** inside the Linux Ubuntu VM Docker stack (`127.0.0.1:5433` / `iot_postgres`) to back up PostgreSQL 18, apply migrations and read the telemetry export contract. [Database guide](database/MIGRATIONS.md)

## Execution & Deployment Scope

The table below defines what runs locally on the ESP32-S3 hardware/LAN, what runs strictly inside the **Linux Ubuntu virtual machine**, and which specific components are deployed across **Cloudflare Tunnel, Workers VPC, and Cloudflare Workers**:

| Subsystem | Path / Resource | Where It Runs | Exposed via Cloudflare Tunnel / Workers? |
| :--- | :--- | :--- | :--- |
| **ESP32-S3 Firmware & TinyML Runtime** | `firmware/src/`, `firmware/include/`, `platformio.ini` | Compiled & flashed via USB (`/dev/ttyACM0`) on the **Linux Ubuntu VM**; executes autonomously **on the ESP32-S3 MCU** | **No** — runs on-device; only sends outbound HTTPS `POST /sensor` requests to the `*.workers.dev` gateway |
| **Embedded Device Dashboard, `/ws` & OTA** | `firmware/data/`, port `80` (`http://<board-lan-ip>/`, `192.168.4.1`) | Hosted **directly on the ESP32-S3 over local Wi-Fi LAN / AP** | **No** — never proxied through Cloudflare; browsers connect directly over LAN (using an HMAC ticket from `/admin/` or device HTTP auth) |
| **TinyML Training & USB Recovery Tools** | `ml/`, `tools/device/` | Executed **offline/locally** in Python 3.12 venvs on the **Linux Ubuntu VM** | **No** — local workstation tools only (`dht_fan_model.h` compiles into firmware; `wifi_info.json` stays gitignored on the VM) |
| **PostgreSQL 18 Database** | `database/`, container `iot_postgres` (`postgres:18.6-alpine3.24`) | Docker Compose inside the **Linux Ubuntu VM** (`postgres:5432` on `iot_net`, `127.0.0.1:5433` on VM loopback) | **No** — strictly private to `iot_backend` on `iot_net` and local maintenance on `127.0.0.1:5433` |
| **Express 5 Backend & Admin UI** | `services/backend/`, container `iot_backend` (`3000/tcp`) | Docker Compose inside the **Linux Ubuntu VM** (`3000/tcp` internal to `iot_net`, no host port published) | **Yes (Private VPC Origin)** — bridged via `iot_cloudflared` -> Tunnel `iot-env-monitor-sys` (`1 VPC` route) -> Workers VPC Service `iot-env-backend` (`HTTP backend:3000`) |
| **Cloudflare Tunnel Connector** | Container `iot_cloudflared` (`cloudflare/cloudflared:2026.10.1`) | Docker Compose inside the **Linux Ubuntu VM** (`iot_net`) | **Yes (Private Transport Only)** — maintains outbound tunnel `iot-env-monitor-sys` (`Routes: 1 VPC`; **no** direct public tunnel hostname) |
| **Cloudflare Workers Edge Gateway** | `services/gateway/` (`wrangler.jsonc`, `src/index.js`) | Deployed from the **Linux Ubuntu VM** via Wrangler onto **Cloudflare Edge (`*.workers.dev`)** | **Yes (Public HTTPS Ingress)** — Workers `iot-env-monitor-sys` & `iot-env-monitor` (`*.sangnguyen232.workers.dev`) forward requests through VPC binding `IOT_BACKEND` |

## System Architecture

```mermaid
flowchart LR
    subgraph hw["Hardware & Local Wi-Fi LAN (Not on Cloudflare)"]
        sensors["DHT20 and soil probe"] --> board["ESP32-S3 firmware (FreeRTOS + INT8 TinyML)"]
        board --> relay["GPIO10 fan command"]
        board --> display["LCD and status LEDs"]
        browser_lan["Browser on Wi-Fi LAN"] <-->|"Direct LAN HTTP :80, /ws & OTA"| board
    end

    subgraph cf["Cloudflare Edge (Public Workers + Private Workers VPC)"]
        workers["Cloudflare Workers (*.workers.dev)<br/>iot-env-monitor-sys / iot-env-monitor"]
        vpc["Workers VPC Service: iot-env-backend<br/>(HTTP -> backend:3000)"]
        workers -->|"Binding: IOT_BACKEND"| vpc
    end

    subgraph vm["Linux Ubuntu Virtual Machine (Docker Compose: iot_net)"]
        tunnel["iot_cloudflared (2026.10.1)<br/>Tunnel: iot-env-monitor-sys (1 VPC route)"]
        api["iot_backend (Express 5)<br/>Internal 3000/tcp only"]
        pg[("iot_postgres (PostgreSQL 18)<br/>iot_net:5432 & VM 127.0.0.1:5433")]
        tunnel -->|"http://backend:3000"| api
        api --> pg
    end

    board -->|"HTTPS POST /sensor"| workers
    browser_remote["Operator Browser"] -->|"HTTPS /login, /admin/*, /healthz"| workers
    vpc <-->|"Outbound Cloudflare Tunnel"| tunnel
    board -.->|"Optional local LAN test POST /sensor"| api
```

The central admin dashboard reads from `iot_postgres` through `iot_backend` inside the Linux Ubuntu VM, published remotely through the Cloudflare Worker (`*.workers.dev`) -> Workers VPC (`iot-env-backend`) -> Cloudflare Tunnel (`iot-env-monitor-sys`) chain. Opening an embedded device dashboard from `/admin/` issues a signed 5-minute HMAC ticket and redirects the browser **directly to the board's LAN IP** (`http://<board-lan-ip>/?ticket=...`—never through Cloudflare). The device continues sampling sensors, running TinyML forecasts and controlling the relay locally when the backend or internet is offline; its in-memory upload queue holds six payloads and discards the oldest when full.

---

## Hardware Pinout

| Component | GPIO / Bus | Configuration & Role |
| :--- | :--- | :--- |
| **ESP32-S3 (Yolo Uno)** | — | 240 MHz MCU, 8 MB Flash (`default_8MB.csv`), FreeRTOS + TFLite Micro |
| **DHT20 Sensor** | I2C (`SDA = GPIO11`, `SCL = GPIO12`) | Ambient temperature (°C) and relative humidity (%) |
| **Soil Moisture Sensor** | ADC (`SOIL_PIN = GPIO2`) | Independent ADC-derived moisture percentage for monitoring |
| **16×2 I2C LCD** | I2C (`0x27`, `SDA = 11`, `SCL = 12`) | Displays `T`, `H`, `SM`, and air-risk status |
| **Status LED** | `LED_GPIO = GPIO48` | Blinks according to temperature risk level |
| **NeoPixel WS2812B** | `NEO_PIN = GPIO45` (`LED_COUNT = 1`) | Displays RGB color according to humidity risk level |
| **Ventilation Fan (Relay)** | `FAN_PIN = GPIO10` | Active-HIGH relay output controlled by `task_fan` |
| **BOOT Button** | `BOOT_PIN = GPIO0` (`INPUT_PULLUP`) | Hold `> 2 s` for factory reset of network, server, and FAN config |

GPIO10 is the relay control signal. Use a fan driver and power supply rated for the fan's operating and starting current. The reported fan state is the command applied to GPIO10. Confirm motion or airflow on the physical fan.

GPIO2 maps 12-bit ADC values linearly to a percentage. The firmware treats rail readings of 0 and 4095 as invalid. The displayed percentage depends on the probe and substrate and needs calibration for a physical moisture measurement. Soil readings remain available when the DHT20 fails and are excluded from fan decisions, air-risk labels and model inputs.

The LCD and dashboards display temperature with one decimal place. Humidity uses tenths where needed and soil moisture uses whole percentages. The LCD fits both air readings on its first row and pads each row to 16 characters. The sensor task keeps the numeric values separately for control and telemetry. [Sensor formatting](firmware/include/sensor_format.h)

## Directory Structure

- `platformio.ini` selects the Yolo Uno board, defaults upload and serial monitor ports to `/dev/ttyACM0` for local flashing/debugging over Linux Ubuntu VM USB passthrough, and maps PlatformIO to the `firmware/` directories (`boards/`, `src/`, `include/`, `lib/`, and `data/` packaged into LittleFS for the board's local LAN web server).
- `services/backend/` contains the Express 5 ingestion API, session handling, login and central admin pages run inside `iot_backend` (`3000/tcp` on `iot_net`) on the Linux Ubuntu VM. `services/gateway/` holds the Cloudflare Worker edge gateway deployed via Wrangler onto `*.workers.dev` with Workers VPC binding `IOT_BACKEND`.
- `database/schema/` and `database/migrations/` define PostgreSQL 18 tables, access grants, sessions, display views and telemetry history inside `iot_postgres` (kept private on `iot_net` and Ubuntu VM loopback `127.0.0.1:5433`). [Existing database upgrades](database/MIGRATIONS.md)
- `ml/` contains the offline Python 3.12 feature definitions, training and INT8 export scripts, history importer, model manifest and local bench guide executed on the Linux Ubuntu VM. The firmware compiles the shipped model statically into the ESP32-S3 image from `firmware/include/dht_fan_model.h` and `firmware/include/fan_model_metadata.h`. [Model and labeling workflow](ml/README.md)
- `tools/device/` contains the local USB utility executed on the Linux Ubuntu VM (`/dev/ttyACM0`) for recovering saved Wi-Fi settings from the board's LittleFS partition.
- `docker-compose.yml` runs `iot_postgres`, `iot_backend`, and `iot_cloudflared` inside the Linux Ubuntu VM. The public configuration templates are [the server environment](.env.example) and [the firmware header](firmware/include/secrets.h.example). Keep credentials, tunnel tokens, device exports and built images containing device secrets private.

## ESP32-S3 Firmware

### FreeRTOS Tasks

At startup the sensor task initializes the DHT20 and LCD, then displays these two 16-character rows for five seconds. The vertical bars mark the edges of the display.

```text
|   IOT    ENV   |
|  MONITOR  SYS  |
```

It then clears the screen and starts sampling. Row one shows temperature and air humidity. Row two shows soil moisture and the air-risk label. A new boot repeats the greeting. If it appears unexpectedly, inspect `[BOOT] reset_reason=...` and the build timestamp on the 115200-baud serial monitor. [Sensor task](firmware/src/environment_monitor.cpp)

The application starts seven FreeRTOS tasks at priority 2. [Startup sequence](firmware/src/main.cpp)

| Task Function | Stack (bytes) | Period / Trigger | Responsibility |
| :--- | :---: | :--- | :--- |
| `temp_humi_monitor` | `6144` | Every `5000 ms` | Reads DHT20 temperature, humidity and the soil ADC. Updates the LCD, publishes sensor JSON and signals changes to other tasks |
| `led_blinky` | `2048` | Phase delay / `semLEDUpdate` | Blinks `GPIO48` (`1000 ms`, `500 ms`, or `100 ms` per HIGH/LOW phase); adapts immediately when `semLEDUpdate` fires |
| `neo_blinky` | `2048` | Event-driven (`semNeoUpdate`) | Updates WS2812B (`GPIO45`) color only when `neoState` changes |
| `task_fan` | `4096` | Notification / `100 ms` timeout | Drives fan relay (`GPIO10`) in `AUTO`/`SHADOW`/`AI`/`MANUAL` with freshness, dwell and runtime protections; pushes WebSocket & DB events on state change |
| `tiny_ml_task` | `8192` | Polls every `100 ms` | Adds each new DHT sample to the temporal window and publishes inference status, scores and agreement with the current reference rule |
| `task_database` | `16384` | Event-driven (`semDBUpdate`) | Sends `POST /sensor` with `200 ms` per-source debounce and fan-event priority |
| `Task_Toggle_BOOT` | `4096` | Polled every `100 ms` | Triggers factory reset if `BOOT` (`GPIO0`) is held `> 2000 ms` |

The Arduino loop performs the following work and delays 30 ms between iterations.

- Executes live Wi-Fi switching (`Wifi_switch_to()`) when `g_wifiSwitchFlag` is raised.
- Services captive DNS and retries the saved station network periodically. A station connection attempt can wait up to ten seconds.
- Keeps the HTTP/WebSocket server active (`Webserver_reconnect()`) and services `ElegantOTA.loop()` through `Webserver_reconnect()`.

HTTP, WebSocket, and OTA handlers are registered once. Wi-Fi reconnects restart the listener without accumulating duplicate handlers.

---

### SharedContext & Synchronization

The sensor, inference, relay and telemetry tasks exchange readings, sample identity and status through `SharedContext`. Its fields are defined in [shared_context.h](firmware/include/shared_context.h).

- **`mutexContext`**: Guards multi-field snapshots of sensor readings, time and model results.
- **`xMutexFanControl`**: Guards `global_fan_state`, `global_fan_mode`, `fan_requested_mode`, `fan_manual_state`, decision reason, and the active `fan_config`.
- **`g_wifiSwitchMutex`**: Guards pending Wi-Fi switch credentials (`g_wifiSwitchSSID`, `g_wifiSwitchPass`, `g_wifiSwitchFlag`).
- **`serialLogLock()` / `serialLogUnlock()`**: Groups serial writes from cooperating tasks.

---

### Risk Classification Policy

The board uses separate temperature and humidity indicators. The status LED blinks with 1,000 ms per phase for 15–25 °C, 500 ms for the adjoining bands from 10 to below 15 °C or above 25 to 30 °C, and 100 ms outside those ranges. The NeoPixel is green for 60–70% RH, yellow for the adjoining bands from 50 to below 60% or above 70 to 80%, and red outside those ranges. The indicators take their last classified values through a failed DHT read.

The LCD air-risk label combines the piecewise temperature and humidity penalties with weights 7/11 and 4/11. The weighted result is Normal at or below 3, Warning above 3 through 6.5, and Critical above 6.5. A temperature of at least 40 °C or relative humidity of at least 90% selects Critical directly. On a failed DHT read the LCD displays `No data`. The firmware sends the label in `Message` for a valid fresh DHT sample and JSON null otherwise. Fan control uses its own saved thresholds. [Risk policy](firmware/include/risk_policy.h)

### TinyML Inference

Each prediction answers “Which reference band will this environment occupy in 30 seconds?” The forecast assumes the sampled fan command persists. The bands are ON at or above either upper threshold, OFF at or below both lower thresholds, and HOLD elsewhere. Current and future bands can differ even with the same instantaneous reading.

- A rolling window holds seven successive valid DHT20 samples, spanning 30 seconds at the nominal period. A zero interval or a gap over eight seconds restarts the window. The feature extractor uses acquisition timestamps to calculate the slope of a fitted line and the latest rate of change for temperature and humidity. The eight inputs are current T and RH, both fitted slopes, both latest rates, the combined residual variation about the trends, and the GPIO command at acquisition.
- Feature extraction uses floating-point arithmetic. TensorFlow Lite Micro quantizes the features, invokes the INT8 FullyConnected and Softmax kernels in a 4 KiB static arena, and decodes three scores in OFF, HOLD, ON order. The model manifest records the byte count, quantization scales and tensor dimensions.
- A broken sequence, expired sample, invalid DHT read, or excursion outside the model domain (5–50°C, 20–100% RH) restarts the history. Seven good samples restore inference. The controller checks sample identity and freshness at actuation.
- SHADOW applies the saved control rule and publishes the forecast alongside the relay decision. AI allows an early ON inside the reference hysteresis band when the model is ready, the saved profile matches and the largest INT8 softmax score is at least 0.80. The supervisor enforces the hard ON/OFF thresholds, dwell and fault handling described below.
- The device API, WebSocket and history expose the version, acquisition and decision identifiers, window count, trend slopes, proposal, scores and reason. Online agreement counts how often the proposal matches the **current** static reference. Evaluating forecast accuracy requires observing the **future** band. [Training and evaluation](ml/README.md) · [Hardware bench procedure](ml/HIL.md)

The fan task owns the GPIO write. Its decision includes a reason such as `rule_on`, `ai_proactive_on`, `min_on_time` or `sensor_invalid`. [Fan policy](firmware/include/fan_policy.h)

```mermaid
flowchart LR
    D[DHT20 sample and timestamp] --> W[Seven-sample window]
    F[Applied fan command at acquisition] --> W
    W --> M[INT8 forecast at +30 s]
    D --> R[Saved hysteresis rules]
    M --> S[Deterministic supervisor]
    R --> S
    D --> S
    S --> G[GPIO10 relay command]
```

---

### Fan Control & Safety Interlocks

The fan task starts with GPIO10 low and the requested mode set to AUTO. It records the applied GPIO state, mode, reason and decision sample sequence. An HTTP 202 acknowledges a control request. Read `/api/status` or the next device update to confirm the applied decision. [Fan task](firmware/src/fan.cpp)

- **AUTO** uses four thresholds saved in **Settings → Fan**. Each OFF threshold must be strictly below its ON threshold. Temperature values must lie within −40 to 80 °C and relative humidity within 0 to 100%. With OR logic, either high threshold starts the fan and both low thresholds stop it. With AND logic, both high thresholds start it and either low threshold stops it. Between those limits the controller preserves its previous decision.
- **SHADOW** applies the AUTO rules and records the independent TinyML proposal for comparison. Both SHADOW and AI require a valid saved configuration.
- **AI** can start ventilation early in the intermediate band. The shipped model requires the OR profile with temperature ON/OFF at 30/28 °C and relative humidity ON/OFF at 75/70%. A ready forecast for the current sample with a top score of at least 0.80 can request early ON. Reaching an upper threshold requests ON and reaching both lower thresholds requests OFF. A different profile or an unusable forecast falls back to the saved AUTO rules.
- **MANUAL** accepts explicit ON or OFF commands without the automatic sensor and dwell conditions. A continuous manual ON run ends after five minutes. A new ON request starts a new run.

In automatic modes the controller holds the relay OFF until it has a valid configuration and DHT20 sample. Readings older than 15 seconds are stale. Normal switches have a ten-second minimum ON/OFF dwell. Sensor loss or unavailable control forces OFF. An automatic mode or configuration change restarts the OFF dwell. On reboot the board reloads the saved thresholds and selects AUTO. [Control policy](firmware/include/fan_policy.h)

### Wi-Fi, Captive Portal & Embedded Web Server (LAN-Only)

With no saved station credentials the board starts a setup access point at `192.168.4.1` using `SSID_AP` and `PASS_AP`. Captive DNS directs clients to the setup page. A station connection attempt can take ten seconds. After a failed attempt the board starts the access point and retries the saved network at intervals of at least 15 seconds. On connection it configures SNTP with `pool.ntp.org` and `time.nist.gov`.

The embedded web server, WebSocket endpoint and ElegantOTA run **exclusively on the board's local network interface** (never exposed through Cloudflare Tunnel or Workers). Access to the password-protected Wi-Fi network grants access to the provisioning page in AP mode. On the station network, protected routes accept the configured HTTP credentials or an `iot_ticket` cookie. Opening `http://<board-lan-ip>/?ticket=...` over the Wi-Fi LAN exchanges a valid backend-signed HMAC-SHA256 ticket (requested via `/admin/` over the `*.workers.dev` gateway or local backend) for this HttpOnly cookie. Verification checks the board MAC, LAN IP and expiry with the synchronized clock. The WebSocket accepts a one-time token from `/api/ws-token` in an initial `{"page":"auth","token":"..."}` message. OTA uses the configured device HTTP credentials. [Device web server](firmware/src/web_server.cpp)

**Device HTTP routes on port 80 (local LAN / AP only)**

- `GET /` exchanges a valid `?ticket=...` for an `HttpOnly` cookie and redirects to the dashboard. Both `/` and `/dashboard.html` serve the authenticated page in station mode.
- `GET /api/status` — Returns AP mode and applied GPIO `fan_state` / `fan_mode`, reason and decision sample/time.
- `GET /api/ai-status` — Returns the sensor/model snapshot plus the applied fan state and decision identifiers. Compare sample sequences to associate an asynchronous fan decision with its acquisition.
- `GET /api/fan-config` — Returns the saved AUTO thresholds and activation logic; before configuration, `configured` is `false` and all four thresholds are `null`.
- `POST /api/fan-config` — Validates and persists `{temperature_on, temperature_off, humidity_on, humidity_off, activation_logic}` and returns the saved configuration with `configured: true`. Uses the same device authentication as relay controls.
- `GET /api/ws-token` — Issues a 30-second one-time token for authenticating `/ws`.
- `GET /toggle-fan?state=ON|OFF` — Switches to `MANUAL` mode and queues the requested fan state (`202 Accepted`); the fan task applies the relay output.
- `GET /set-mode?mode=AUTO|SHADOW|AI|MANUAL` — Acknowledges a requested mode (202); applied mode is reported by the controller. AI/SHADOW require a saved valid fallback configuration.
- `GET /api/wifi-list` — Lists saved SSIDs from `/wifi_list.json` (passwords omitted).
- `POST /api/wifi-switch` — Queues live Wi-Fi network switching (`{ssid, pass}`).
- `GET /api/server-url` — Returns current `g_sensorApiUrl` (for example the Cloudflare Worker `*.workers.dev` HTTPS origin).
- `/update` — ElegantOTA firmware/filesystem update UI (HTTP Basic Auth on local LAN).

---

### LittleFS Storage & Factory Reset

| LittleFS Path | Purpose |
| :--- | :--- |
| `/dashboard.html`, `/dashboard.css`, `/dashboard.js` | Device dashboard page and its public CSS/JavaScript served locally from port 80. Direct static requests for saved configuration files are filtered. |
| `/info.dat` | Active Wi-Fi JSON (`WIFI_SSID`, `WIFI_PASS`, `STA_IP`) |
| `/wifi_list.json` | Saved Wi-Fi credentials (new SSIDs are prepended and existing entries are updated in place) |
| `/fan.json`, `/fan.json.tmp` | Saved FAN AUTO thresholds and OR/AND activation logic plus the temporary save file; both are blocked from direct static access |
| `/server.json` | Optional runtime override `{"url": "https://..."}` for `SENSOR_API_URL` (such as the deployed Cloudflare Worker `*.workers.dev` URL) |

Holding GPIO0 low for more than two seconds while the application runs clears saved Wi-Fi, server and fan settings and restarts the board. The next boot opens the setup access point. Uploading a LittleFS image from the Linux Ubuntu VM also replaces stored settings. The firmware enables formatting on mount failure. [Storage implementation](firmware/src/device_config.cpp)

---

## Backend, Database & Edge Gateway

### Backend API Endpoints

Implemented in `services/backend/src/index.js` (Express 5, listening on internal `3000/tcp` inside container `iot_backend` on the Linux Ubuntu VM, and published externally through Cloudflare Workers + Workers VPC + Cloudflare Tunnel):

| Endpoint | Method | Auth | Description |
| :--- | :---: | :---: | :--- |
| `/healthz` | `GET` | — | Database connectivity health check (`200` / `503`) |
| `/sensor` | `POST` | `X-Device-Key` | Validates and inserts ESP32 telemetry into `sensor_logs` |
| `/login` | `GET` / `POST` | — | Login page & rate-limited session login (`express-session`) |
| `/logout` | `POST` | — | Destroys active session |
| `/api/me` | `GET` | — | Returns `loggedIn`, with `username` and `role` for a signed-in account |
| `/admin/*` | `GET` | Logged in | Serves static Admin Dashboard (`admin.html`, `admin.css`, `admin.js`) |
| `/admin/api/history` | `GET` | Logged in | Device/LAN-scoped paginated experiment history, optional time filters; see [migration and history contract](database/MIGRATIONS.md) |
| `/admin/api/devices` | `GET` | Logged in | Latest record & online age per `(device_id, lan_ip)` filtered by RBAC |
| `/admin/api/devices/:device_id` | `DELETE` | Admin | Deletes logs for a device, optionally scoped by `?lan_ip=...` |
| `/admin/api/devices/:device_id/ticket` | `POST` | Logged in | Verifies device password & returns a 5-minute HMAC ticket |
| `/admin/api/devices/:device_id/has-password` | `GET` | Admin | Checks whether a device password is set |
| `/admin/api/devices/:device_id/password` | `POST` / `DELETE` | Admin | Sets/updates or removes a device password (`bcrypt`) |
| `/admin/api/devices/:device_id/access-request` | `POST` | User | Requests temporary admin approval for a passwordless device |
| `/admin/api/access-requests` | `GET` | Admin | Lists pending temporary device access requests |
| `/admin/api/access-requests/:id/status` | `GET` | User | Polls request decision and receives HMAC ticket upon approval |
| `/admin/api/access-requests/:id/decision` | `POST` | Admin | Approves or denies a pending access request |
| `/admin/api/users` | `GET` | Admin | Lists system accounts |
| `/admin/api/users` | `POST` | Admin | Creates a new `admin` / `user` account |
| `/admin/api/users/:id/devices` | `GET` / `PUT` | Admin | Reads or updates `(device_id, lan_ip)` access grants for a `user` |

---

### PostgreSQL Schema & Migrations (Private to the Linux Ubuntu VM)

Configured for **PostgreSQL 18** (`timezone=Asia/Ho_Chi_Minh`, running in container `iot_postgres` on the Linux Ubuntu VM and **not** exposed on Cloudflare Tunnel—accessible only to `iot_backend` on `iot_net:5432` and locally on VM loopback `127.0.0.1:5433`):

- **`sensor_logs`** (`database/schema/base.sql`): Stores `id`, `timestamp_real`, `timestamp_up`, `received_at`, numeric `temperature`, `humidity`, optional `soil_moisture` (`0..100` or `null`), `"FAN_state"`, `"MODE_state"`, `"Message"`, `"Score"`, `device_id` (MAC), `lan_ip`, `latency` (µs), and `trigger_source` (`sensor` | `fan` | `ai`), plus `boot_id`, `sample_seq`, `sampled_uptime_ms`, `ai`, `fan_reason`, `fan_config`, `fan_decision_sample_seq` and `fan_decided_uptime_ms`. Retention uses the server receipt time, falling back to upload time for older rows. Cleanup runs at startup and every six hours. `SENSOR_RETENTION_DAYS` defaults to 30 and setting it to 0 disables automatic deletion. The firmware sends `Score: null` and writes model scores to `ai.probabilities`. Its `latency` field measures acquisition-to-payload preparation on the device.
- **`device_credentials`** (`database/schema/base.sql`): Stores per-device `bcrypt` password hashes (`device_id` PK).
- **`system_users` & `user_devices`** (`database/migrations/001_auth.sql`): Stores `admin`/`user` accounts and per-user `(device_id, lan_ip)` permissions.
- **`session`** (`database/migrations/003_session_login_at.sql`): Persistent PostgreSQL session store (`connect-pg-simple`) with `login_at` timestamp.
- **`display.*` views** (`database/migrations/004_time_display_views.sql`): Read-only views formatting all timestamps as `YYYY-MM-DD HH24:MI:SS` in `Asia/Ho_Chi_Minh`.
- **`005_ai_telemetry.sql`**: Additive experiment metadata and display-view refresh; see [database/MIGRATIONS.md](database/MIGRATIONS.md) for existing volumes.
- **`002_timezone.sql`**: Standalone migration helper for upgrading legacy `timestamp without time zone` installations.

---

### Authentication, RBAC & HMAC Device Tickets

- **Password Security**: New backend account passwords and per-device dashboard passwords are hashed with bcrypt at cost 10. Successful verification can upgrade a legacy plaintext record. Direct HTTP login on the ESP32 uses separate firmware credentials. The backend rate-limits failed sign-in and ticket-password attempts.
- **Role-based access**
  - **`admin`**: Full visibility across all devices, bulk log deletion, device password management, user creation, `(device_id, lan_ip)` grant assignment, and approval of passwordless access requests.
  - A **user** can view granted devices. A grant can match a specific LAN IP or cover all IPs for a device. For LAN access, the user enters a per-device dashboard password or requests approval from an administrator. The backend issues a five-minute HMAC ticket after verification or approval.

---

### Cloudflare Workers, Workers VPC & Cloudflare Tunnel

Only the central HTTP origin (`iot_backend:3000`) and its edge proxy (`services/gateway/`) are deployed through Cloudflare, following this four-layer topology:

- **1. Containerized Origin inside the Linux Ubuntu VM (`docker-compose.yml`):** Three containers run on the Docker bridge `iot_net`: `iot_postgres` (`postgres:18.6-alpine3.24`, bound only to `127.0.0.1:5433->5432/tcp` on the Ubuntu VM), `iot_backend` (`3000/tcp` internal to `iot_net` with `TRUST_PROXY=1` and no published host port), and `iot_cloudflared` (`cloudflare/cloudflared:2026.10.1`, running `cloudflared --no-autoupdate tunnel run`).
- **2. Outbound Cloudflare Tunnel (`iot-env-monitor-sys`):** `iot_cloudflared` registers 1 replica of tunnel `iot-env-monitor-sys` outbound from the Ubuntu VM without opening inbound ports on the VM, hypervisor, or router. The tunnel has **no public hostname route**—its sole configured route is **`1 VPC`** for Cloudflare Workers VPC.
- **3. Cloudflare Workers VPC Service (`iot-env-backend`):** Configured as an `HTTP` VPC Service (`service_id: 01a13b15-2978-7a33-963b-441c3925539c`) bound to tunnel `iot-env-monitor-sys`, targeting internal hostname `backend` on port `HTTP:3000` (resolved by `iot_cloudflared` on `iot_net`).
- **4. Cloudflare Workers Edge Gateways on `*.workers.dev` (`services/gateway/`):** Deployed manually from the Linux Ubuntu VM with Wrangler (`"workers_dev": true`, no custom domains and no Cloudflare Access gate in front of the Worker). In the reference deployment, Worker `iot-env-monitor-sys` (`https://iot-env-monitor-sys.sangnguyen232.workers.dev`, defined in `services/gateway/wrangler.jsonc`) and companion Worker `iot-env-monitor` (`https://iot-env-monitor.sangnguyen232.workers.dev`) bind `env.IOT_BACKEND` to VPC Service `iot-env-backend`, rewrite incoming requests to `http://backend:3000`, set `X-Forwarded-Proto: https` and `X-Forwarded-Host`, strip `X-Forwarded-For`, and forward `/sensor`, `/healthz`, `/login`, `/logout`, `/api/me`, and `/admin/*` to `iot_backend`.
- **Transport security note:** Local LAN HTTP sends the shared key in clear text, whereas remote ESP32 telemetry to `https://<worker>.<subdomain>.workers.dev/sensor` encrypts traffic via `WiFiClientSecure` with certificate verification disabled (`setInsecure()`). Use the device and backend on trusted networks. [Telemetry transport](firmware/src/telemetry_client.cpp)

---

## Dashboards

### Embedded Device Dashboard (Local LAN Only)

Hosted directly by the ESP32-S3 on port 80 over the local Wi-Fi LAN (`http://<board-lan-ip>/`) or setup AP (`http://192.168.4.1/`), never routed through Cloudflare:

- **Dashboard** (`#dashboard`) displays temperature, air humidity, soil moisture, a clock, the air-risk notification and applied fan/mode badges. Its 60-point chart can add a reading every five or fifteen seconds and has a local canvas fallback. The map shows a fixed marker and uses online tiles. [Device dashboard](firmware/data/dashboard.html)
- **Settings → WiFi** (`#settings/wifi`) manages credentials, saved-network switching and the backend URL (pointing to the Cloudflare Worker `*.workers.dev` HTTPS address or a local test IP).
- **Settings → Fan** (`#settings/fan`) exposes the four thresholds, OR/AND logic, requested mode and manual ON/OFF. Its badges and reason report the applied decision.
- **Settings → TinyML** (`#settings/tinyml`) shows window fill, fitted slopes, reference class, forecast, scores, model version and sample identity. An expired or mismatched result clears the current proposal.

### Central Admin Dashboard (Published via Cloudflare Worker + VPC + Tunnel)

Served by `iot_backend` through the Cloudflare Worker `*.workers.dev` HTTPS gateway (or locally on `localhost:3000` during host-Node tests on the Linux Ubuntu VM), the central admin dashboard polls every five seconds for the latest row per device and LAN IP. It displays device and sample freshness, exports a time range as JSONL, and lets an administrator manage accounts, grants, per-device passwords and access requests. Selecting **Open dashboard** obtains an HMAC ticket from `iot_backend` and opens a **direct LAN connection** from the operator's browser to `http://<board-lan-ip>/?ticket=...` (requiring the browser to be on the same Wi-Fi LAN or a bridged Ubuntu VM). [Admin dashboard](services/backend/public/admin/admin.html)

## TinyML Training Pipeline (Local Python 3.12 on the Linux Ubuntu VM)

Developed and executed **offline/locally** in Python 3.12 inside the **Linux Ubuntu virtual machine** (never deployed to Docker or Cloudflare), `ml/train_export.py` generates independent synthetic trajectories and labels each window using the simulated temperature and humidity 30 seconds later. It fits the network, calibrates INT8 quantization from training samples and evaluates the exported model against the current band, a linear forecast and the most frequent training class. The bundled 5,536-byte model is identified by `fan-trend-int8-v2-8abd0b91c744`. Its manifest reports 87.28% desktop INT8 accuracy on 3,600 synthetic test episodes, 71.03% for the instantaneous band and 82.94% for 30-second linear extrapolation. These figures describe the simulator. Training writes a feature CSV, portable model, JSON manifest and two firmware headers under the selected output directory. The repository ships the two headers and the matching manifest, so PlatformIO on the Ubuntu VM compiles the weights directly into the ESP32-S3 firmware. [Model manifest](ml/models/fan_model_manifest.json)

For field evaluation on the Linux Ubuntu VM, export JSONL for one device from `/admin/` (via the deployed `*.workers.dev` gateway or local test backend) and run `ml/import_history.py` locally to match each reading and fan decision by boot and sample sequence and build labeled windows from continuous sessions. Independent sessions and physical measurements are needed to evaluate forecasting and ventilation in the enclosure. [Training and history import](ml/README.md) · [Bench procedure](ml/HIL.md)

## Device Utility Tools (Local USB on the Linux Ubuntu VM)

`tools/device/pull_wifi_info.py` runs **strictly locally** inside the Linux Ubuntu VM over USB passthrough (`/dev/ttyACM0`), reads the ESP32-S3 LittleFS partition via `esptool`, and combines the saved Wi-Fi list with the active station IP, when available. It writes SSIDs, saved Wi-Fi passwords and available station IP values to the Git-ignored local path `local/device/wifi_info.json`. [Installation and usage](GUIDE.md#8-workstation-tools-on-the-linux-ubuntu-vm)

## Installation & Deployment

All coding, local testing, firmware/LittleFS flashing over USB passthrough, HIL bench checks, and selective deployment of the Express backend + Cloudflare Worker VPC gateway over Cloudflare Tunnel were performed on a **Linux Ubuntu virtual machine**. Use the setup guide to reproduce the local Ubuntu VM workflow, firmware provisioning, and the Docker + Cloudflare Tunnel + Workers VPC + Wrangler deployment. The migration guide covers PostgreSQL 18 volumes on the Ubuntu VM. [Setup guide](GUIDE.md) · [Database upgrades](database/MIGRATIONS.md)

## Libraries & Runtime Versions

- **Reference Workstation & Host Platform** uses a **Linux Ubuntu virtual machine** (`sang@Linux`, Ubuntu 26.04 LTS x86_64 guest VM, Docker Engine + Compose (`docker compose` / `docker-compose`), `cloudflare/cloudflared:2026.10.1`, USB CDC passthrough on `/dev/ttyACM0`, branch `project_linux`).
- **Firmware (local build -> ESP32-S3 MCU)** uses PlatformIO environment `yolo_uno`, Arduino on `espressif32@7.1.3`, LittleFS, the local LCD driver and the bundled TensorFlow Lite Micro sources. PlatformIO resolves the pins for ESPAsyncWebServer, ArduinoJson, ElegantOTA, Adafruit NeoPixel and DHT20. [PlatformIO configuration](platformio.ini)
- **Backend & Cloudflare Worker Gateway** declare Node `>=26.12.0 <27` and npm `>=12.2.0 <13` (`.nvmrc` pins `26.12.0` on the Ubuntu VM). Use `npm ci` in the chosen service directory to install its lockfile. `iot_backend` uses Express 5 with `iot_postgres` on PostgreSQL 18 (`postgres:18.6-alpine3.24`). `services/gateway` uses Wrangler 4 to publish Cloudflare Workers onto `*.workers.dev` bound to Workers VPC (`IOT_BACKEND`). [Backend manifest](services/backend/package.json) · [Gateway manifest](services/gateway/package.json) · [Compose services](docker-compose.yml)
- **Offline Training & USB Device Utilities (local Ubuntu VM only)** run in separate Python 3.12 virtual environments (`.python-version`). NumPy, TensorFlow CPU and Keras support training and INT8 export; `esptool` and `littlefs-python` read LittleFS over USB. [Training dependencies](ml/requirements.txt) · [USB reader dependencies](tools/device/requirements.txt)

## License notices

The root license file contains the MIT license. The backend package declares ISC in its npm metadata. Bundled firmware libraries carry their upstream notices in the source tree. [Root license](LICENSE) · [Backend package metadata](services/backend/package.json) · [FlatBuffers notice](firmware/lib/TensorFlowLite_ESP32/src/third_party/flatbuffers/LICENSE.txt) · [gemmlowp notice](firmware/lib/TensorFlowLite_ESP32/src/third_party/gemmlowp/LICENSE)
