# User & Developer Onboarding Guide (`GUIDE.md`)

This guide walks new users and developers through every stage of setting up, configuring, building, running, operating, and verifying the **IoT-Env-Monitor** system—from cloning the repository to running the cloud/Docker backend, flashing the ESP32-S3 microcontroller, training TinyML models, and validating end-to-end telemetry.

For deep architectural specifications, FreeRTOS task internals, REST API tables, and mathematical policies, refer to [README.md](README.md), [database/MIGRATIONS.md](database/MIGRATIONS.md), and [ml/README.md](ml/README.md).

---

## Table of Contents

1. [Where Each Component Runs](#1-where-each-component-runs)
2. [Required Technologies, Languages, Environments & Constraints](#2-required-technologies-languages-environments--constraints)
3. [Step 1: Clone the Repository](#3-step-1-clone-the-repository)
4. [Step 2: Configure Environment Variables & Firmware Secrets](#4-step-2-configure-environment-variables--firmware-secrets)
5. [Step 3: Start the Database, Backend & Tunnel](#5-step-3-start-the-database-backend--tunnel)
6. [Step 4: Deploy or Develop the Cloudflare Worker Gateway (Optional)](#6-step-4-deploy-or-develop-the-cloudflare-worker-gateway-optional)
7. [Step 5: Build, Flash & Provision the ESP32-S3 Firmware](#7-step-5-build-flash--provision-the-esp32-s3-firmware)
8. [Step 6: Operate the Admin & Embedded Device Dashboards](#8-step-6-operate-the-admin--embedded-device-dashboards)
9. [Step 7: Optional Python Workflows (TinyML & Flash Utilities)](#9-step-7-optional-python-workflows-tinyml--flash-utilities)
10. [Step 8: Verification & End-to-End Smoke Testing](#10-step-8-verification--end-to-end-smoke-testing)
11. [Operational Constraints & Troubleshooting](#11-operational-constraints--troubleshooting)

---

## 1. Where Each Component Runs

`IoT-Env-Monitor` is a multi-component monorepo. Understanding **where** each directory executes prevents setup mistakes:

| Subproject / Path | Execution Target | How It Runs |
| :--- | :--- | :--- |
| `database/` + `docker-compose.yml` | **Server / Host Machine** (Linux, macOS, or Windows WSL2 with Docker) | Runs PostgreSQL `18.6` (`iot_postgres`), the Express 5 Backend (`iot_backend`), and Cloudflare Tunnel (`iot_cloudflared`) inside an isolated Docker bridge network (`iot_net`). |
| `services/backend/` | **Inside Docker (`iot_backend`)** *or* **Directly on Host** (local dev) | Node.js `26.12.0` server on port `3000` serving `/sensor` ingestion, `/login`, and `/admin/*`. |
| `services/gateway/` | **Cloudflare Edge** (or local Wrangler dev simulator) | Optional Cloudflare Worker (`iot-env-monitor-sys`) forwarding public HTTPS traffic through a Cloudflare VPC Service binding (`IOT_BACKEND`) into `iot_cloudflared` → `http://backend:3000`. |
| `firmware/` + `platformio.ini` | **Built on Workstation → Flashed to ESP32-S3 (`Yolo_Uno_S3`)** | Compiled with PlatformIO (`pio` CLI or VS Code) from the **repository root** and flashed over USB-CDC (`/dev/ttyACM0` / `COMx`), then runs standalone on the microcontroller (`port 80` HTTP + `/ws` WebSocket). |
| `ml/` | **Developer Workstation** (Offline Python `3.12+` venv) | Generates datasets, trains/validates Keras → TFLite models, exports C headers into `firmware/include/`, and converts exported JSONL history into session-grouped CSVs. Not needed at runtime unless retraining. |
| `tools/device/` | **Developer Workstation** (with ESP32-S3 attached via USB) | Reads the raw LittleFS flash partition via `esptool` and exports saved Wi-Fi credentials to `local/device/wifi_info.json`. |

---

## 2. Required Technologies, Languages, Environments & Constraints

### 2.1 Programming Languages & Frameworks

- **Firmware (`firmware/`)**: C++17 on **Arduino / ESP-IDF** (`espressif32@7.1.3`), FreeRTOS, LittleFS, `ESPAsyncWebServer`, `ArduinoJson` v7, `ElegantOTA`, and vendored `TensorFlowLite_ESP32` (TFLite Micro).
- **Backend (`services/backend/`)**: JavaScript (**CommonJS**, Node.js `26`), Express 5, `pg`, `express-session` + `connect-pg-simple`, `helmet`, `bcryptjs`.
- **Edge Gateway (`services/gateway/`)**: JavaScript (**ES Modules**), Cloudflare Workers Runtime (`compatibility_date: 2026-10-14`), Wrangler CLI v4.
- **Database (`database/`)**: SQL / PL/pgSQL targeting **PostgreSQL 18** (`timezone=Asia/Ho_Chi_Minh`).
- **Dashboards (`firmware/data/`, `services/backend/public/`)**: Vanilla HTML5, CSS3, and browser JavaScript (Chart.js 4.5.1 + offline HTML5 Canvas fallback, Leaflet 1.9.4).
- **ML & Tooling (`ml/`, `tools/device/`)**: **Python 3.12+** (`numpy`, `tensorflow`, `keras`, `esptool`, `littlefs-python`).

### 2.2 Software Environment & Version Constraints

| Tool / Runtime | Required Version | Required For | Version Constraint Notes |
| :--- | :--- | :--- | :--- |
| **Git** | `2.30+` | Cloning & source control | Standard Git CLI. |
| **Docker Engine & Compose** | Docker `24+`, Compose `v2+` | Running PostgreSQL, Backend & Tunnel | `docker-compose.yml` uses Compose v2+ variable interpolation (`${VAR:?message}`) and binds PostgreSQL to `127.0.0.1:5433` on the host. |
| **PlatformIO Core (`pio`)** | `6.1+` | Building & flashing ESP32-S3 firmware & LittleFS | Automatically downloads `espressif32@7.1.3` and pinned `lib_deps` (`lib_compat_mode = strict`). |
| **Node.js & npm** | Node `>=26.12.0 <27`, npm `>=12.2.0 <13` (`.nvmrc`: `26.12.0`) | Running `services/backend` on host or deploying `services/gateway` | Strictly declared in `package.json` `engines`. Not required on the host if you only run the backend via Docker Compose without deploying the Worker. |
| **Python** | `>=3.12` (`.python-version`: `3.12`) | Retraining TinyML (`ml/train_export.py`) | `numpy==2.5.4`, `tensorflow-cpu==2.21.0`, and `keras==3.15.1` require Python 3.12+. (`ml/import_history.py` shares the NumPy window extractor; `tools/device/` works on Python 3.10+). |

> **VS Code Extension Constraint**: If opening the repository in VS Code, install `platformio.platformio-ide`. Do **not** enable `pioarduino.pioarduino-ide` or `ms-vscode.cpptools-extension-pack` concurrently in this workspace (see `.vscode/extensions.json`), as they conflict with PlatformIO's toolchain indexing.

### 2.3 Hardware Wiring & Electrical Constraints

Target board: **Yolo Uno (`ESP32-S3`, 240 MHz, 8 MB QIO Flash, `default_8MB.csv` partition table, native USB-CDC `0x303A:0x1001`)**.

| Peripheral | ESP32-S3 Pin / Bus | Mandatory Hardware Constraints |
| :--- | :--- | :--- |
| **DHT20 Air Sensor** | I2C (`SDA = GPIO11`, `SCL = GPIO12`) | Shares the I2C bus with the LCD (`3.3V` logic). Valid range: `-40..80°C`, `0..100% RH`. |
| **16×2 I2C LCD** | I2C (`0x27`, `SDA = GPIO11`, `SCL = GPIO12`) | Must use I2C backpack address `0x27`. |
| **Soil Moisture Probe** | Analog ADC (`GPIO2`) | Optional independent channel. Raw 12-bit ADC rail values `0` and `4095` are treated as disconnected/faulty (`null`). |
| **Status LED** | `GPIO48` | Active-HIGH digital output. |
| **RGB LED (WS2812B)** | `GPIO45` (`LED_COUNT = 1`) | Single addressable NeoPixel (`NEO_GRB + NEO_KHZ800`). |
| **Ventilation Fan Relay** | `GPIO10` (Active-HIGH: `HIGH = ON`, `LOW = OFF`) | **Never power a fan motor directly from an ESP32 GPIO pin.** Drive an optocoupler/transistor relay module with flyback protection and size the external DC/AC power supply for the fan's inrush/stall current. |
| **BOOT Button** | `GPIO0` (`INPUT_PULLUP`) | Holding `LOW` for `> 2 seconds` erases all saved Wi-Fi, server URL, and FAN settings and reboots into AP Mode. |

**Linux USB Serial Permission Constraint**: On Linux (Ubuntu/Debian/Arch), ensure your user belongs to `dialout` (or `uucp`) so `/dev/ttyACM0` can be opened without `sudo`:

```bash
sudo usermod -aG dialout "$USER"
# Log out and log back in (or run: newgrp dialout) for group changes to take effect.
```

---

## 3. Step 1: Clone the Repository

Open a terminal on your workstation or server and clone the repository:

```bash
git clone https://github.com/SangNguyen-232/IoT-Env-Monitor.git
cd IoT-Env-Monitor
```

All PlatformIO, Docker Compose, ML, and utility commands in this guide assume **your current working directory is the repository root (`IoT-Env-Monitor/`)** unless explicitly noted otherwise.

---

## 4. Step 2: Configure Environment Variables & Firmware Secrets

Secret configuration files are excluded from Git via `.gitignore`. Create both local files from their tracked templates before building or starting any service:

```bash
cp .env.example .env
cp firmware/include/secrets.h.example firmware/include/secrets.h
```

### 4.1 Edit `.env` (Backend, PostgreSQL & Cloudflare Tunnel)

Open `.env` and set strong, non-placeholder values:

| Variable | Required | Default / Example | Purpose & Constraints |
| :--- | :---: | :--- | :--- |
| `DB_HOST` | Yes | `localhost` | Used when running `services/backend` directly on the host (`docker-compose.yml` overrides this to `postgres` inside Docker). |
| `DB_NAME` | Yes | `iot_db` | PostgreSQL database name. |
| `DB_USER` | Yes | `iot_user` | PostgreSQL application role. |
| `DB_PASS` | **Yes** | *(strong password)* | PostgreSQL password. Docker Compose and the backend refuse to start if empty. |
| `DB_PORT` | Yes | `5433` | Host-side port mapped to PostgreSQL (`127.0.0.1:5433 -> 5432`). Inside Docker, `backend` connects on `5432` automatically. |
| `SENSOR_RETENTION_DAYS` | Yes | `30` | Whole integer `0..999999`. Purges `sensor_logs` older than `N` days on startup and every 6 hours. Set `0` to disable auto-deletion during lab collection. |
| `SESSION_SECRET` | **Yes** | *(64+ hex chars)* | Signs Express session cookies (`openssl rand -hex 32`). Required in production (`NODE_ENV=production`). |
| `SENSOR_API_KEY` | **Yes** | *(long shared secret)* | **Must match `SENSOR_API_KEY` in `firmware/include/secrets.h` byte-for-byte.** Authenticates `POST /sensor` (`X-Device-Key`) and signs 5-minute HMAC LAN device tickets. |
| `ADMIN_USERNAME` | Yes | `admin` | Initial administrator username seeded on first boot when `system_users` is empty. |
| `ADMIN_PASSWORD` | **Yes** | *(strong password)* | Initial administrator password (hashed with `bcryptjs` cost `10` on first boot). |
| `CLOUDFLARE_TUNNEL_TOKEN` | Mode-dependent | *(tunnel token)* | Required when starting the `cloudflared` service in `docker-compose.yml`. See Section 5.2 if running LAN-only without Cloudflare. |

### 4.2 Edit `firmware/include/secrets.h` (ESP32-S3 Firmware)

Open `firmware/include/secrets.h` and configure:

| Macro | Purpose & Constraints |
| :--- | :--- |
| `SSID_AP` | Fallback Wi-Fi Access Point SSID (`1–32` chars, e.g., `"ESP32 LOCAL"`). |
| `PASS_AP` | WPA2 password for AP Mode (**must be `8–63` ASCII characters**; ESP32 `softAP` rejects passwords shorter than 8 characters or falls back to an open network). |
| `DEVICE_HTTP_USER` | HTTP Basic Auth username for direct LAN access and `/update` ElegantOTA. |
| `DEVICE_HTTP_PASS` | HTTP Basic Auth password for direct LAN access and `/update` ElegantOTA. |
| `SENSOR_API_KEY` | **Must match `SENSOR_API_KEY` in `.env` identically.** |
| `SENSOR_API_URL` | Default backend base URL (e.g., `"https://your-gateway.workers.dev"` or `"http://192.168.1.100:3000"`). Can be overridden at runtime via the device's **Settings → Wi-Fi** form (`/server.json` on LittleFS). |

---

## 5. Step 3: Start the Database, Backend & Tunnel

Choose **Deployment Mode A** (full stack with Cloudflare Tunnel), **Mode B** (local LAN Docker without Cloudflare), or **Mode C** (PostgreSQL in Docker + Node.js on host for backend development).

### 5.1 Mode A — Full Docker Compose Stack with Cloudflare Tunnel (Recommended)

From the repository root:

```bash
docker compose up -d --build
```

Verify that all three containers (`iot_postgres`, `iot_backend`, `iot_cloudflared`) are running and healthy:

```bash
docker compose ps
docker compose logs --tail=50 backend
```

What happens automatically on first boot of an empty `fan_pgdata18` volume:

1. `iot_postgres` initializes `iot_db` with `timezone=Asia/Ho_Chi_Minh` and runs `base.sql`, `001_auth.sql`, `003_session_login_at.sql`, `004_time_display_views.sql`, and `005_ai_telemetry.sql`.
2. `iot_backend` waits for `iot_postgres` healthcheck, verifies schema columns (`ensureSchema()`), creates/updates the `session` table, seeds the initial admin user (`ADMIN_USERNAME` / `ADMIN_PASSWORD`), runs initial log retention cleanup, and listens on internal port `3000`.
3. `iot_cloudflared` connects outbound to Cloudflare once `iot_backend` passes `/healthz`.

> **Upgrading an Existing Database Volume**: Docker skips `/docker-entrypoint-initdb.d` when `fan_pgdata18` already contains data. **Never run `docker compose down -v`**, which destroys all stored telemetry and users. Follow [database/MIGRATIONS.md](database/MIGRATIONS.md) to back up and apply `005_ai_telemetry.sql` safely.

### 5.2 Mode B — Local LAN Stack Without Cloudflare Tunnel

If you do not have a Cloudflare Tunnel configured yet and want to run everything on your local Wi-Fi/LAN:

1. Set a dummy non-empty placeholder for `CLOUDFLARE_TUNNEL_TOKEN=unused-local` in `.env` (so Compose interpolation succeeds), and start **only** `postgres` and `backend` while publishing port `3000` on your LAN, **or** run Mode C below.
2. Quickest LAN method (Mode C — PostgreSQL in Docker + Backend on Host):

```bash
# 1. Start only PostgreSQL 18 in Docker (bound to 127.0.0.1:5433)
docker compose up -d postgres

# 2. Install backend dependencies (requires Node.js 26.12.x and npm 12.2.x)
cd services/backend
npm ci

# 3. Start the backend on port 3000 with variables loaded from the root .env
node --env-file=../../.env src/index.js
```

When running directly on a LAN over plain HTTP (`http://<HOST_LAN_IP>:3000`):

- Open `http://localhost:3000/login` (or `http://<HOST_LAN_IP>:3000/login`) in your browser.
- Set `SENSOR_API_URL` in `firmware/include/secrets.h` (or in the ESP32 **Settings → Wi-Fi** UI) to `http://<HOST_LAN_IP>:3000` and ensure your host firewall allows inbound TCP `3000` from the ESP32 subnet.

---

## 6. Step 4: Deploy or Develop the Cloudflare Worker Gateway (Optional)

`services/gateway/` is only required if exposing `iot_backend` publicly through a Cloudflare Tunnel VPC Service binding:

1. Ensure your Cloudflare account has a Tunnel pointing to `http://backend:3000` and a VPC Service ID matching `vpc_services[0].service_id` in `services/gateway/wrangler.jsonc`.
2. From `services/gateway/` (requires Node.js `>=26.12.0 <27` and npm `>=12.2.0 <13`):

```bash
cd services/gateway
npm ci

# Local development preview via Wrangler:
npm run dev

# Deploy to Cloudflare Workers:
npx wrangler login
npm run deploy
```

---

## 7. Step 5: Build, Flash & Provision the ESP32-S3 Firmware

Run all PlatformIO commands from the **repository root** (`IoT-Env-Monitor/`, where `platformio.ini` is located).

### 7.1 Compile Firmware (No Hardware Attached Needed)

```bash
pio run -e yolo_uno
```

### 7.2 Flash Firmware & LittleFS Web Assets Over USB

Connect the Yolo Uno (`ESP32-S3`) to your computer via a data-capable USB-C cable:

```bash
# 1. Compile and flash the application firmware binary
pio run -e yolo_uno --target upload

# 2. Build and flash the LittleFS filesystem image (firmware/data/dashboard.{html,css,js})
pio run -e yolo_uno --target uploadfs

# 3. Open the UART serial monitor (115200 baud; press Ctrl+C to exit)
pio device monitor
```

- **Custom Serial Port**: `platformio.ini` defaults to `/dev/ttyACM0`. If your OS assigns a different port (e.g., `/dev/ttyACM1`, `/dev/cu.usbmodem101`, or `COM5`), override it on the command line:

  ```bash
  pio run -e yolo_uno --target upload --upload-port /dev/ttyACM1
  pio run -e yolo_uno --target uploadfs --upload-port /dev/ttyACM1
  pio device monitor --port /dev/ttyACM1
  ```

- **Important `uploadfs` Warning**: Flashing `uploadfs` overwrites the entire LittleFS partition, erasing saved `/info.dat`, `/wifi_list.json`, `/server.json`, and `/fan.json`. Normal firmware uploads (`--target upload`) and reboots preserve LittleFS files.
- **Over-The-Air (OTA) Updates**: Once provisioned on Wi-Fi, subsequent firmware or LittleFS `.bin` builds can also be uploaded in a browser at `http://<ESP32_LAN_IP>/update` using `DEVICE_HTTP_USER` and `DEVICE_HTTP_PASS`.

### 7.3 First-Boot Wi-Fi & Backend Provisioning

1. On first boot after `uploadfs` (or after holding `BOOT` `> 2 s`), the LCD displays `IOT ASSIGNMENT` for 5 seconds and the ESP32-S3 starts **AP Mode** using `SSID_AP` and `PASS_AP` from `firmware/include/secrets.h`.
2. Connect a phone or laptop to that Wi-Fi AP and open `http://192.168.4.1/` (a captive portal prompt usually opens automatically).
3. Navigate to **Settings → Wi-Fi** (`#settings/wifi`), enter your 2.4 GHz router **SSID**, **Wi-Fi Password** (ESP32-S3 supports **2.4 GHz Wi-Fi only**, not 5 GHz), and optional **Backend URL** (`https://...` or `http://<HOST_LAN_IP>:3000`), then submit.
4. The ESP32-S3 saves `/info.dat` and `/wifi_list.json`, reboots into **STA Mode**, prints `STA Mode IP address: <ESP32_LAN_IP>` on Serial (`115200` baud), synchronizes `UTC+7` time via SNTP (`pool.ntp.org` / `time.nist.gov`), and begins posting telemetry to `POST /sensor` every 5 seconds.

---

## 8. Step 6: Operate the Admin & Embedded Device Dashboards

### 8.1 Central Admin Dashboard (`/login` → `/admin/admin.html`)

1. Open your backend URL (e.g., `http://localhost:3000/login` or your Cloudflare Gateway HTTPS domain) and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
2. Once an ESP32-S3 posts telemetry (requires internet/NTP time sync on the ESP32), its card appears automatically with live Temperature, Air Humidity, Soil Moisture, TinyML status, online/offline indicator, and a **JSONL Export** button.
3. **Role-Based Access Control (Admin Actions)**:
   - Click **Create User** in the header to create standard `user` accounts (password `>= 6` characters).
   - Click **Assign Permissions** to grant a `user` access to specific `(device_id, lan_ip)` pairs.
   - Click the arrow button on any device card to open **Device Management**: jump straight into the Embedded Device Dashboard, or set/change/remove a per-device password (`bcrypt`).
4. **Opening the Embedded Device Dashboard as a Standard `user`**:
   - Ensure your browser is connected to the **same local network (LAN)** as the ESP32-S3 (`http://<ESP32_LAN_IP>/` is a local LAN address).
   - If the device has a backend password set, enter it to receive a backend-signed 5-minute HMAC ticket (`http://<ESP32_LAN_IP>/?ticket=...`), which the ESP32 exchanges for an `HttpOnly` cookie (`iot_ticket`).
   - If the device has no backend password set, the `user` modal automatically sends a real-time access request to online Administrators and redirects as soon as an Admin clicks **Approve**.
   - Alternatively, anyone with `DEVICE_HTTP_USER` / `DEVICE_HTTP_PASS` can open `http://<ESP32_LAN_IP>/` directly via HTTP Basic Auth.

### 8.2 Configuring Fan Control & Running TinyML Modes (`#settings/fan` & `#settings/tinyml`)

1. On the Embedded Device Dashboard, open **Settings → FAN** (`#settings/fan`).
2. **Save Thresholds First**: By design, `AUTO` mode keeps the fan relay **OFF** (`config_required`) until you save four valid thresholds (`temperature_on`, `temperature_off`, `humidity_on`, `humidity_off`) with `OFF < ON` (`-40..80°C`, `0..100%`) and select **OR** (`any`) or **AND** (`all`).
3. **Operating Modes**:
   - **`AUTO`**: Drives `GPIO10` strictly from your saved hysteresis thresholds (`10 s` minimum ON/OFF dwell; immediate OFF if DHT20 fails or becomes older than `15 s`).
   - **`SHADOW`**: Actuates using your saved `AUTO` rules while recording TinyML predictions side-by-side in telemetry for safe observation. Requires saved fallback thresholds.
   - **`AI`** allows a forecast to start the fan before a threshold crossing. The firmware needs a full window of seven valid samples, a matching sample identity, inputs within 5–50°C and 20–100% RH, a top INT8 score of at least 0.80, and the saved OR profile of 30/28°C and 75/70% RH. During warm-up or a failed model gate, the supervisor uses your saved AUTO rules. Independent deterministic checks enforce upper and lower thresholds, dwell and shutoff on sensor loss.
   - **`MANUAL`**: Enables the manual `ON/OFF` toggle button and enforces a 5-minute (`300 s`) automatic safety shutoff.
4. **Reboot Behavior**: Any reboot resets the active mode back to `AUTO` while preserving your saved `/fan.json` thresholds.

For the paired rising/falling demo, the six manual tests and their expected Serial/UI evidence, follow the [Vietnamese replay and HIL guide](ml/HIL.vi.md).

---

## 9. Step 7: Optional Python Workflows (TinyML & Flash Utilities)

### 9.1 Retraining or Inspecting the TinyML Model (`ml/`)

Requires **Python 3.12+**:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r ml/requirements.txt

# Train and export a candidate build into a temporary folder first (leaves repo files untouched):
python ml/train_export.py --output-dir /tmp/iot-fan-candidate

# Or overwrite the 5 co-versioned repository artifacts in ml/ and firmware/include/, then reflash firmware:
python ml/train_export.py
```

From the ML environment, convert exported Admin Dashboard JSONL history into a deduplicated, session-grouped CSV for manual labeling:

```bash
python3 ml/import_history.py /path/to/exported-history.jsonl --output /tmp/fan-unlabeled.csv
```

The importer can label windows using subsequent readings from the same session. For command-line options, label provenance and split rules, see [the ML workflow](ml/README.md).

### 9.2 Reading Saved Wi-Fi Credentials from ESP32 Flash (`tools/device/`)

With the ESP32-S3 connected via USB (close `pio device monitor` first so the serial port is free):

```bash
python3 -m venv .venv-tools
source .venv-tools/bin/activate
python -m pip install -r tools/device/requirements.txt

python tools/device/pull_wifi_info.py --port /dev/ttyACM0
```

This reads the `default_8MB.csv` LittleFS partition (`offset 0x670000`, `size 0x180000`) and writes merged SSID/password/`sta_ip` entries to `local/device/wifi_info.json` (gitignored).

---

## 10. Step 8: Verification & End-to-End Smoke Testing

For the embedded INT8 model, run the [C++ host replay](ml/HIL.vi.md). The additional checks below cover the firmware build, web applications and backend.

### 10.1 Syntax & Static Verification (Backend, Gateway, Dashboards & Python)

```bash
# Verify Node.js & browser JavaScript syntax
node --check services/backend/src/index.js
node --check services/backend/src/telemetry.js
node --check services/backend/public/admin/admin.js
node --check firmware/data/dashboard.js
node --input-type=module --check < services/gateway/src/index.js

# Verify Python scripts via AST parsing without writing __pycache__ bytecode
python3 -B -c "import ast, pathlib; [ast.parse(pathlib.Path(f).read_text('utf-8'), f) for f in ('ml/train_export.py', 'ml/import_history.py', 'tools/device/pull_wifi_info.py')]"
```

### 10.2 Firmware Compilation Verification

```bash
pio run -e yolo_uno
# Optional: remove local .pio build artifacts when finished inspecting
pio run -e yolo_uno --target clean
```

### 10.3 Backend & Database Health + Simulated Telemetry Test

With the Docker stack running (`docker compose up -d`), run a health check and send a valid test telemetry payload (replace `<YOUR_SENSOR_API_KEY>` with `SENSOR_API_KEY` from `.env`):

```bash
# 1. Check backend + PostgreSQL connectivity inside the container
docker compose exec -T backend node -e \
  "fetch('http://127.0.0.1:3000/healthz').then(async r => { console.log(r.status, await r.json()); process.exit(r.ok ? 0 : 1); })"

# 2. Send a simulated ESP32 telemetry payload to POST /sensor
docker compose exec -T backend node -e "
  fetch('http://127.0.0.1:3000/sensor', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Key': process.env.SENSOR_API_KEY
    },
    body: JSON.stringify({
      timestamp_real: '2026-11-25T10:00:00Z',
      timestamp_up: '2026-11-25T10:00:01Z',
      temperature: 28.5,
      humidity: 71,
      soil_moisture: 45,
      FAN_state: 'OFF',
      MODE_state: 'SHADOW',
      Message: 'Normal',
      Score: null,
      device_id: 'AA:BB:CC:DD:EE:99',
      lan_ip: '192.168.1.50',
      latency: 1200,
      trigger_source: 'sensor',
      boot_id: '0123456789abcdef0123456789abcdef',
      sample_seq: 7,
      sampled_uptime_ms: 35000,
      fan_reason: 'rule_off',
      fan_decision_sample_seq: 7,
      fan_decided_uptime_ms: 35050,
      fan_config: {
        configured: true,
        activation_logic: 'any',
        temperature_on: 30,
        temperature_off: 28,
        humidity_on: 75,
        humidity_off: 70
      },
      ai: {
        model_version: 'fan-trend-int8-v2-8abd0b91c744',
        status: 'ready',
        sample_seq: 7,
        sampled_uptime_ms: 35000,
        predicted_class: 'ON',
        window_samples: 7, window_capacity: 7,
        temp_slope_c_min: 2.4, humi_slope_pct_min: 14.4,
        residual_jitter: 0, fan_on_at_sample: false,
        probabilities: [0, 0.00390625, 0.99609375],
        inference_ms: 0.42,
        rule_class: 'HOLD',
        agreement_pct: 0.0,
        evaluated_samples: 1
      }
    })
  }).then(async r => { console.log('POST /sensor ->', r.status, await r.text()); process.exit(r.ok ? 0 : 1); });
"

# 3. Clean up the simulated test device from PostgreSQL afterward
docker compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DELETE FROM sensor_logs WHERE device_id = '\''AA:BB:CC:DD:EE:99'\'';"'
```

---

## 11. Operational Constraints & Troubleshooting

| Symptom / Error | Root Cause | Resolution |
| :--- | :--- | :--- |
| `sensor_logs is missing required columns` on backend startup | Existing PostgreSQL volume created before `005_ai_telemetry.sql` | Do **not** delete the volume. Back up and apply `database/migrations/005_ai_telemetry.sql` as documented in [database/MIGRATIONS.md](database/MIGRATIONS.md). |
| ESP32 connects to Wi-Fi (`STA Mode IP address: ...`) but **never** sends `POST /sensor` | System clock has not synchronized via SNTP yet (`tvUp.tv_sec < 1577836800`) | Ensure the Wi-Fi network has outbound UDP `123` access to `pool.ntp.org` / `time.nist.gov`. `telemetry_client.cpp` intentionally drops epoch-invalid payloads until NTP sync completes. |
| `[DB] POST failed -> 401` on ESP32 Serial monitor | `SENSOR_API_KEY` mismatch between `.env` and `firmware/include/secrets.h` | Make both keys identical, rebuild/flash firmware (`pio run -e yolo_uno -t upload`), and recreate the backend container (`docker compose up -d backend`). |
| `403 invalid or expired ticket` when opening ESP32 from Admin Dashboard | SNTP not synced on ESP32, `SENSOR_API_KEY` mismatch, >5 minutes elapsed, or ESP32 LAN IP changed | Verify NTP sync on ESP32, check `SENSOR_API_KEY` parity, click Refresh on Admin Dashboard to get the latest `lan_ip`, and request a fresh ticket (or log in directly at `http://<ESP32_LAN_IP>/` with `DEVICE_HTTP_USER` / `DEVICE_HTTP_PASS`). |
| `HTTP 409: Save a valid AUTO fallback configuration first` when selecting `AI` or `SHADOW` | `/fan.json` has not been configured yet (or was wiped by `uploadfs` / factory reset) | Open **Settings → FAN** (`#settings/fan`), enter four valid thresholds (`OFF < ON`), click Save, and then switch mode. |
| `fan_reason: ai_fallback_profile_mismatch` while in `AI` mode | Saved FAN thresholds/logic differ from the shipped model's training profile | Either set FAN thresholds to `T ON/OFF = 30 / 28°C`, `RH ON/OFF = 75 / 70%`, logic **OR** (`any`), or retrain/export a new model matching your profile. |
| ESP32 cannot find or connect to Wi-Fi router | Router SSID is 5 GHz-only or WPA3-only, or `PASS_AP` < 8 chars | Connect the ESP32-S3 to a **2.4 GHz WPA2** network and ensure `PASS_AP` in `secrets.h` is `8–63` characters. |
| `Permission denied: '/dev/ttyACM0'` during `pio run -t upload` | Current Linux user lacks serial device group access, or `pio device monitor` is holding the port | Close any active serial monitor and add your user to `dialout` (`sudo usermod -aG dialout "$USER"`). |
