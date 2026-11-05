# ESP32-S3 IoT Environmental Monitoring System

A real-time IoT environmental monitoring and irrigation control system running on the **ESP32-S3 (Yolo Uno)** microcontroller, paired with a containerized **Node.js + PostgreSQL** backend, **Cloudflare Tunnel / Worker Gateway**, and an on-device **TinyML** risk classifier.

---

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Hardware Pinout](#hardware-pinout)
- [Directory Structure](#directory-structure)
- [ESP32-S3 Firmware](#esp32-s3-firmware)
  - [FreeRTOS Tasks](#freertos-tasks)
  - [SharedContext &amp; Synchronization](#sharedcontext--synchronization)
  - [Risk Classification Policy](#risk-classification-policy)
  - [TinyML Inference](#tinyml-inference)
  - [Pump Control &amp; Safety Interlocks](#pump-control--safety-interlocks)
  - [Wi-Fi, Captive Portal &amp; Embedded Web Server](#wi-fi-captive-portal--embedded-web-server)
  - [LittleFS Storage &amp; Factory Reset](#littlefs-storage--factory-reset)
- [Backend, Database &amp; Edge Gateway](#backend-database--edge-gateway)
  - [Backend API Endpoints](#backend-api-endpoints)
  - [PostgreSQL Schema &amp; Migrations](#postgresql-schema--migrations)
  - [Authentication, RBAC &amp; HMAC Device Tickets](#authentication-rbac--hmac-device-tickets)
  - [Cloudflare Tunnel &amp; Worker Gateway](#cloudflare-tunnel--worker-gateway)
- [Dashboards](#dashboards)
  - [Embedded Device Dashboard](#embedded-device-dashboard)
  - [Central Admin Dashboard](#central-admin-dashboard)
- [TinyML Training Pipeline](#tinyml-training-pipeline)
- [Device Utility Tools](#device-utility-tools)
- [Installation &amp; Deployment](#installation--deployment)
- [Libraries &amp; Runtime Versions](#libraries--runtime-versions)

---

## Overview

Every **5 seconds**, each ESP32-S3 node samples **temperature**, **air humidity**, and **soil moisture**, then coordinates local actuation, edge inference, and telemetry reporting:

1. **16×2 I2C LCD (`0x27`)** displays live `T`, `H`, `SM`, and composite safety status (`NORM` / `WARN` / `CRIT`).
2. **Status LED (`GPIO48`)** blinks at a period determined by temperature risk (`Normal` 1000 ms, `Warning` 500 ms, `Critical` 100 ms per phase).
3. **WS2812B NeoPixel (`GPIO45`)** updates color on state transitions according to air humidity risk (Green / Yellow / Red).
4. **Irrigation Pump (`GPIO10`)** operates in `AUTO` mode (with hysteresis, max-runtime cutoff, cooldown, stale-sample protection, and ineffective-watering fault lock) or `MANUAL` mode (with a 5-minute safety cutoff).
5. **TinyML (`TensorFlow Lite Micro`)** runs a float32 neural network (`3 → 32 → 16 → 3`) on-chip and tracks cumulative rolling accuracy (`mlRollAcc`) against the mathematical policy.
6. **Embedded Web Server (`port 80` + `/ws`)** serves the local Device Dashboard over LittleFS to authenticated clients and supports browser-based OTA updates (`/update`).
7. **Telemetry Client** posts JSON payloads (`X-Device-Key`) over HTTP/HTTPS to the Node.js backend (`POST /sensor`), which stores records in **PostgreSQL 18** for multi-device monitoring via the **Admin Dashboard**.

---

## System Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│                        ESP32-S3 (Yolo Uno)                           │
│                                                                      │
│  FreeRTOS Tasks (priority 2)          SharedContext + Mutex/Sem      │
│  ├── temp_humi_monitor (4096w)  ───►  temperature, humidity          │
│  ├── led_blinky        (2048w)  ◄───  soilMoisture, soilSampleValid  │
│  ├── neo_blinky        (2048w)  ◄───  ledState, neoState, lcdState   │
│  ├── task_pump         (3072w)  ◄──►  mlRollAcc, dbTriggerSource     │
│  ├── tiny_ml_task      (8192w)  ◄──►  timestampReal / timestampRealUs│
│  ├── task_database     (8192w)  ◄───  sem{LED,Neo,DB}Update          │
│  └── Task_Toggle_BOOT  (4096w)                                       │
│                                                                      │
│  LittleFS: /dashboard.{html,css,js}, /info.dat, /wifi_list.json,     │
│            /server.json                                              │
│  ESPAsyncWebServer (:80) + Authenticated WebSocket (/ws) + ElegantOTA│
└──────────────────┬───────────────────────────────────┬───────────────┘
                   │ HTTPS POST /sensor                │ LAN HTTP / WS
                   │ (Header: X-Device-Key)            │ (HMAC Ticket or Basic Auth)
                   ▼                                   ▼
┌──────────────────────────────────────┐     ┌─────────────────────────┐
│ Cloudflare Worker Gateway (optional) │     │ Browser (Same LAN)      │
│ services/gateway (VPC Service proxy) │     │ Embedded Device UI      │
└──────────────────┬───────────────────┘     └─────────────────────────┘
                   │ cloudflared tunnel                ▲ ?ticket=<HMAC>
                   ▼                                   │
┌──────────────────────────────────────────────────────┴───────────────┐
│                   Docker Compose Stack (iot_net)                     │
│  ├── cloudflared : Cloudflare Tunnel connector                       │
│  ├── backend     : Node.js + Express 5 (:3000, Admin UI + REST API)  │
│  └── postgres    : PostgreSQL 18 (iot_db, Asia/Ho_Chi_Minh)          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Hardware Pinout

| Component                         | GPIO / Bus                                 | Configuration & Role                                                   |
| :-------------------------------- | :----------------------------------------- | :--------------------------------------------------------------------- |
| **ESP32-S3 (Yolo Uno)**     | —                                         | 240 MHz MCU, 8 MB Flash (`default_8MB.csv`), FreeRTOS + TFLite Micro |
| **DHT20 Sensor**            | I2C (`SDA = GPIO11`, `SCL = GPIO12`)   | Ambient temperature (°C) and relative humidity (%)                    |
| **Soil Moisture Sensor**    | ADC (`SOIL_PIN = GPIO2`)                 | Raw ADC `[0–4095]` mapped linearly to `[0–100]%`                 |
| **16×2 I2C LCD**           | I2C (`0x27`, `SDA = 11`, `SCL = 12`) | Displays `T`, `H`, `SM`, and composite safety status             |
| **Status LED**              | `LED_GPIO = GPIO48`                      | Blinks according to temperature risk level                             |
| **NeoPixel WS2812B**        | `NEO_PIN = GPIO45` (`LED_COUNT = 1`)   | Displays RGB color according to humidity risk level                    |
| **Mini Water Pump (Relay)** | `PUMP_PIN = GPIO10`                      | Active-HIGH relay output controlled by `task_pump`                   |
| **BOOT Button**             | `BOOT_PIN = GPIO0` (`INPUT_PULLUP`)    | Hold `> 2 s` for factory reset of network/server config              |

---

## Directory Structure

```text
IoT-Env-Monitor/
├── database/
│   ├── schema/
│   │   └── base.sql                       # Core tables: sensor_logs, device_credentials
│   └── migrations/
│       ├── 001_auth.sql                   # system_users & user_devices (RBAC)
│       ├── 002_timezone.sql               # Legacy timestamp -> timestamptz conversion
│       ├── 003_session_login_at.sql       # Express session table + login_at column
│       └── 004_time_display_views.sql     # Read-only display.* views in Vietnam time
├── firmware/
│   ├── boards/
│   │   └── yolo_uno.json                  # Custom PlatformIO board manifest (ESP32-S3 8MB)
│   ├── data/                              # LittleFS web assets (uploaded via uploadfs)
│   │   ├── dashboard.html
│   │   ├── dashboard.css
│   │   └── dashboard.js
│   ├── include/
│   │   ├── device_config.h                # LittleFS config & Wi-Fi credential persistence
│   │   ├── dht_risk_model.h               # Embedded TFLite model byte array (alignas(16))
│   │   ├── environment_monitor.h          # Sensor polling + LCD + WebSocket broadcast task
│   │   ├── factory_reset.h                # BOOT button long-press reset task
│   │   ├── input_safety.h                 # Sanitization, frame checks, freshness helpers
│   │   ├── message_handler.h              # Authenticated WebSocket command dispatcher
│   │   ├── pump.h                         # Pump state & mutex declarations
│   │   ├── rgb_led.h                      # NeoPixel task declaration
│   │   ├── risk_policy.h                  # Safety interlock + piecewise risk scoring
│   │   ├── secrets.h.example              # Template for firmware/include/secrets.h
│   │   ├── serial_log.h                   # Mutex-protected Serial logging
│   │   ├── shared_context.h               # SharedContext struct & Wi-Fi switch sync primitives
│   │   ├── status_led.h                   # Single LED blink task declaration
│   │   ├── telemetry_client.h             # HTTP/HTTPS backend telemetry task declaration
│   │   ├── tinyml.h                       # TinyML task declaration
│   │   ├── web_server.h                   # Embedded HTTP/WS/OTA server interface
│   │   └── wifi_manager.h                 # STA/AP/Captive DNS/SNTP manager
│   ├── lib/
│   │   └── lcd_i2c/                       # Local LiquidCrystal_I2C driver
│   └── src/                               # Firmware C++ implementations
│       ├── main.cpp
│       ├── device_config.cpp
│       ├── environment_monitor.cpp
│       ├── factory_reset.cpp
│       ├── message_handler.cpp
│       ├── pump.cpp
│       ├── rgb_led.cpp
│       ├── serial_log.cpp
│       ├── shared_context.cpp
│       ├── status_led.cpp
│       ├── telemetry_client.cpp
│       ├── tinyml.cpp
│       ├── web_server.cpp
│       └── wifi_manager.cpp
├── ml/
│   ├── data/
│   │   └── dataset.csv                    # Generated training dataset (21,000 samples)
│   ├── models/
│   │   └── dht_risk_model.tflite          # Exported float32 TFLite model
│   ├── requirements.txt                   # Python dependencies (numpy, tensorflow)
│   └── train_export.py                    # Dataset generator, trainer, validator & C exporter
├── services/
│   ├── backend/                           # Express 5 + PostgreSQL API & Admin UI
│   │   ├── public/
│   │   │   ├── admin/                     # Multi-device Admin Dashboard (HTML/CSS/JS)
│   │   │   └── login/                     # Session Login UI
│   │   ├── src/
│   │   │   └── index.js                   # Server entrypoint
│   │   ├── Dockerfile
│   │   ├── .dockerignore
│   │   ├── package.json
│   │   └── package-lock.json
│   └── gateway/                           # Cloudflare Worker reverse proxy (VPC Service)
│       ├── src/
│       │   └── index.js
│       ├── package.json
│       ├── package-lock.json
│       └── wrangler.jsonc
├── tools/
│   └── device/
│       ├── pull_wifi_info.py              # Reads /wifi_list.json from ESP32 LittleFS partition
│       └── requirements.txt               # esptool, littlefs-python
├── .editorconfig
├── .env.example                           # Environment variable template for Docker / Backend
├── .gitignore
├── .nvmrc
├── .python-version
├── docker-compose.yml                     # PostgreSQL 18 + Backend + Cloudflared stack
├── platformio.ini                         # PlatformIO configuration (env:yolo_uno)
└── pyproject.toml                         # Python tooling configuration
```

---

## ESP32-S3 Firmware

### FreeRTOS Tasks

`setup()` initializes `SharedContext`, synchronization primitives, LittleFS configuration, and spawns **7 FreeRTOS tasks** at priority `2`:

| Task Function         | Stack (words) | Period / Trigger                | Responsibility                                                                                                                                                     |
| :-------------------- | :-----------: | :------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `temp_humi_monitor` |   `4096`   | Every `5000 ms`               | Reads DHT20 & soil ADC, computes risk states, updates 16×2 LCD, broadcasts WebSocket sensor JSON, signals `semLEDUpdate`, `semNeoUpdate`, and `semDBUpdate` |
| `led_blinky`        |   `2048`   | Phase delay / `semLEDUpdate`  | Blinks `GPIO48` (`1000 ms`, `500 ms`, or `100 ms` per HIGH/LOW phase); adapts immediately when `semLEDUpdate` fires                                      |
| `neo_blinky`        |   `2048`   | Event-driven (`semNeoUpdate`) | Updates WS2812B (`GPIO45`) color only when `neoState` changes                                                                                                  |
| `task_pump`         |   `3072`   | Every `100 ms`                | Drives pump relay (`GPIO10`) in `AUTO` or `MANUAL` mode with runtime/fault protections; pushes WebSocket & DB events on state change                         |
| `tiny_ml_task`      |   `8192`   | Every `5000 ms`               | Runs TFLite Micro inference on `[T, H, SM]` and updates cumulative `mlRollAcc`                                                                                 |
| `task_database`     |   `8192`   | Event-driven (`semDBUpdate`)  | Sends `POST /sensor` with `200 ms` per-source debounce and pump-event priority                                                                                 |
| `Task_Toggle_BOOT`  |   `4096`   | Polled every `50 ms`          | Triggers factory reset if `BOOT` (`GPIO0`) is held `> 2000 ms`                                                                                               |

`loop()` handles non-blocking runtime maintenance (`100 ms` cadence):

- Executes live Wi-Fi switching (`Wifi_switch_to()`) when `g_wifiSwitchFlag` is raised.
- Steps the non-blocking STA reconnection state machine (`Wifi_reconnect()`) and Captive Portal DNS server (`Wifi_processCaptiveDNS()`).
- Keeps the HTTP/WebSocket server active (`Webserver_reconnect()`) and services `ElegantOTA.loop()`.

---

### SharedContext & Synchronization

Defined in `firmware/include/shared_context.h`:

```cpp
struct SharedContext {
    float temperature;
    float humidity;
    int soilMoisture;
    bool soilSampleValid;
    uint32_t soilSampledAtMs;
    SemaphoreHandle_t mutexContext;
    SemaphoreHandle_t semLEDUpdate;
    int ledState;
    SemaphoreHandle_t semNeoUpdate;
    int neoState;
    int lcdState;
    SemaphoreHandle_t semDBUpdate;
    time_t timestampReal;
    suseconds_t timestampRealUs;
    float mlRollAcc;
    char dbTriggerSource[8];   // "sensor" | "pump"
};
```

- **`mutexContext`**: Guards reads/writes to `SharedContext` fields across tasks.
- **`xMutexPumpControl`**: Guards `global_pump_state`, `global_pump_mode`, `pump_manual_control`, and `pump_manual_state`.
- **`g_wifiSwitchMutex`**: Guards pending Wi-Fi switch credentials (`g_wifiSwitchSSID`, `g_wifiSwitchPass`, `g_wifiSwitchFlag`).
- **`serialLogLock()` / `serialLogUnlock()`**: Prevents interleaved UART logs across concurrent tasks.

---

### Risk Classification Policy

Defined in `firmware/include/risk_policy.h` (`1 = Normal`, `2 = Warning`, `3 = Critical`):

1. **Temperature (`ledState`)**:
   - `Normal`: `15°C ≤ T ≤ 25°C` (`1000 ms` blink phase)
   - `Warning`: `10°C ≤ T < 15°C` or `25°C < T ≤ 30°C` (`500 ms` blink phase)
   - `Critical`: `T < 10°C` or `T > 30°C` (`100 ms` blink phase)
2. **Air Humidity (`neoState`)**:
   - `Normal`: `60% ≤ H ≤ 70%` → Green `(0, 255, 0)`
   - `Warning`: `50% ≤ H < 60%` or `70% < H ≤ 80%` → Yellow `(255, 255, 0)`
   - `Critical`: `H < 50%` or `H > 80%` → Red `(255, 0, 0)`
3. **Composite Safety Label (`lcdState` & DB `Message`)**:
   - **Hard Safety Interlock**: Immediately returns `Critical (3)` if `T ≥ 40°C`, `H ≥ 90%`, `soil < 15%`, or `soil > 60%`.
   - **Weighted Piecewise Penalty (`risk_pure_mathematical_label`)**:
     $$
     r = 0.35 \cdot \text{score}(T) + 0.20 \cdot \text{score}(H) + 0.45 \cdot \text{score}(\text{soil})
     $$

     - `r ≤ 3.0` → `Normal (1)`
     - `3.0 < r ≤ 6.5` → `Warning (2)`
     - `r > 6.5` → `Critical (3)`

---

### TinyML Inference

Implemented in `firmware/src/tinyml.cpp` using `TensorFlowLite_ESP32`:

- **Architecture**: `Input(3) → Dense(32, ReLU) → Dense(16, ReLU) → Dense(3, Softmax)` (float32, 16 KiB tensor arena).
- **Validation**: Skips invalid/NaN sensor readings (`sensor_readings_valid()`), compares `argmax` prediction against `risk_pure_mathematical_label()`, and updates session-wide rolling accuracy `mlRollAcc` (reported to PostgreSQL in the `Score` field).

---

### Pump Control & Safety Interlocks

Implemented in `firmware/src/pump.cpp` on `PUMP_PIN = GPIO10`:

- **Freshness Guard**: In `AUTO` mode, if no valid soil sample has been recorded within `SOIL_SAMPLE_STALE_MS` (`15 s`), the pump stays `OFF`.
- **AUTO Mode**:
  - Turns **ON** when `soilMoisture < 25%` (`PUMP_SOIL_ON`).
  - Turns **OFF** when `soilMoisture ≥ 32%` (`PUMP_SOIL_OFF`).
  - **Max Run & Cooldown**: Stops after `60 s` (`PUMP_MAX_RUN_MS`) and enforces a `120 s` cooldown (`PUMP_COOLDOWN_MS`).
  - **Dry-Run / Fault Lockout**: If `3` consecutive timed-out runs fail to raise soil moisture by at least `+3%` (`PUMP_MIN_RISE`), `AUTO` mode locks out until soil moisture recovers to `≥ 32%` or manual intervention occurs.
- **MANUAL Mode**:
  - Controlled via `/toggle-pump`, `/set-mode`, or WebSocket commands.
  - Automatically shuts off and latches after `5 minutes` (`PUMP_MANUAL_MAX_RUN_MS = 300000 ms`) to prevent flooding.

---

### Wi-Fi, Captive Portal & Embedded Web Server

- **Provisioning & Fallback**:
  - Boots into **AP Mode** (SSID `ESP32_Config` by default, or `WIFI_AP_SSID` / `WIFI_AP_PASS` from `secrets.h`) with a captive DNS server (`192.168.4.1`) when no Wi-Fi credentials exist.
  - If a saved STA network becomes unreachable across **3 consecutive failed retry cycles**, automatically falls back to **AP+STA** mode so local reconfiguration remains accessible while retrying STA every `15 s`.
  - Synchronizes system clock via SNTP (`UTC+7`, `pool.ntp.org` / `time.nist.gov`) upon STA connection.
- **Device Authentication (`requireDeviceAuth`)**:
  - In **AP Mode**, WPA2 protects access so captive portal setup works seamlessly.
  - In **STA Mode**, requests must present either:
    1. A valid `iot_ticket` `HttpOnly` cookie exchanged from a backend-signed **HMAC-SHA256 ticket** (`GET /?ticket=...`, bound to `<MAC>:<LAN_IP>:<expiresAt_ms>`), or
    2. HTTP Basic Auth matching `DEVICE_HTTP_USER` / `DEVICE_HTTP_PASS`.
  - **WebSocket (`/ws`)** requires a one-time token from `GET /api/ws-token` sent in an initial `{"page":"auth","token":"..."}` frame; unauthenticated sockets receive no telemetry and cannot issue commands.
- **Embedded HTTP Endpoints (`port 80`)**:
  - `GET /` & `GET /dashboard.html` — Exchanges `?ticket=...` (if present) for an `HttpOnly` cookie and serves the Device Dashboard.
  - `GET /api/status` — Returns `{"is_ap_mode": bool}`.
  - `GET /api/ws-token` — Issues a 30-second one-time token for authenticating `/ws`.
  - `GET /toggle-pump?state=ON|OFF` — Switches to `MANUAL` mode and sets/toggles pump state.
  - `GET /set-mode?mode=AUTO|MANUAL` — Switches/toggles pump mode and logs the state transition.
  - `GET /api/wifi-list` — Lists saved SSIDs from `/wifi_list.json` (passwords omitted).
  - `POST /api/wifi-switch` — Queues live Wi-Fi network switching (`{ssid, pass}`).
  - `GET /api/server-url` — Returns current `g_sensorApiUrl`.
  - `/update` — ElegantOTA firmware/filesystem update UI (HTTP Basic Auth).

---

### LittleFS Storage & Factory Reset

| LittleFS Path                                              | Purpose                                                                                                                             |
| :--------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| `/dashboard.html`, `/dashboard.css`, `/dashboard.js` | Embedded Device Dashboard static assets (protected from unauthenticated access; internal config files are blocked by static filter) |
| `/info.dat`                                              | Active Wi-Fi JSON (`WIFI_SSID`, `WIFI_PASS`, `STA_IP`)                                                                        |
| `/wifi_list.json`                                        | Saved Wi-Fi history (`[{"ssid","pass","sta_ip"}, ...]`, newest first)                                                             |
| `/server.json`                                           | Optional runtime override `{"url": "https://..."}` for `SENSOR_API_URL`                                                         |

**Factory Reset (`BOOT_PIN = GPIO0` held `> 2 s`)**:

- Deletes `/info.dat`, `/wifi_list.json`, and `/server.json` from LittleFS, then reboots into AP Mode.

---

## Backend, Database & Edge Gateway

### Backend API Endpoints

Implemented in `services/backend/src/index.js` (Express 5, port `3000`):

| Endpoint                                         |        Method        |       Auth       | Description                                                                 |
| :----------------------------------------------- | :-------------------: | :--------------: | :-------------------------------------------------------------------------- |
| `/healthz`                                     |        `GET`        |        —        | Database connectivity health check (`200` / `503`)                      |
| `/sensor`                                      |       `POST`       | `X-Device-Key` | Validates and inserts ESP32 telemetry into `sensor_logs`                  |
| `/login`                                       |  `GET` / `POST`  |        —        | Login page & rate-limited session login (`express-session`)               |
| `/logout`                                      |       `POST`       |        —        | Destroys active session                                                     |
| `/api/me`                                      |        `GET`        |        —        | Returns `{loggedIn, username, role}`                                      |
| `/admin/*`                                     |        `GET`        |    Logged in    | Serves static Admin Dashboard (`admin.html`, `admin.css`, `admin.js`) |
| `/admin/api/devices`                           |        `GET`        |    Logged in    | Latest record & online age per `(device_id, lan_ip)` filtered by RBAC     |
| `/admin/api/devices/:device_id`                |      `DELETE`      |      Admin      | Deletes logs for a device (optionally scoped by `?lan_ip=...`)            |
| `/admin/api/devices/:device_id/ticket`         |       `POST`       |    Logged in    | Verifies device password & returns a 5-minute HMAC ticket                   |
| `/admin/api/devices/:device_id/has-password`   |        `GET`        |      Admin      | Checks whether a device password is set                                     |
| `/admin/api/devices/:device_id/password`       | `POST` / `DELETE` |      Admin      | Sets/updates or removes a device password (`bcrypt`)                      |
| `/admin/api/devices/:device_id/access-request` |       `POST`       |       User       | Requests temporary admin approval for a passwordless device                 |
| `/admin/api/access-requests`                   |        `GET`        |      Admin      | Lists pending temporary device access requests                              |
| `/admin/api/access-requests/:id/status`        |        `GET`        |       User       | Polls request decision and receives HMAC ticket upon approval               |
| `/admin/api/access-requests/:id/decision`      |       `POST`       |      Admin      | Approves or denies a pending access request                                 |
| `/admin/api/users`                             |  `GET` / `POST`  |      Admin      | Lists system accounts or creates a new `admin` / `user` account         |
| `/admin/api/users/:id/devices`                 |   `GET` / `PUT`   |      Admin      | Reads or updates `(device_id, lan_ip)` access grants for a `user`       |

---

### PostgreSQL Schema & Migrations

Configured for **PostgreSQL 18** (`timezone=Asia/Ho_Chi_Minh`):

- **`sensor_logs`** (`database/schema/base.sql`): Stores `id`, `timestamp_real`, `timestamp_up`, `received_at`, numeric `temperature`, `humidity`, `soil_moisture`, `"PUMP_state"`, `"MODE_state"`, `"Message"`, `"Score"`, `device_id` (MAC), `lan_ip`, `latency` (µs), and `trigger_source` (`sensor` | `pump`). Rows older than `SENSOR_RETENTION_DAYS` (default `90`, `0` disables) are purged automatically every 6 hours.
- **`device_credentials`** (`database/schema/base.sql`): Stores per-device `bcrypt` password hashes (`device_id` PK).
- **`system_users` & `user_devices`** (`database/migrations/001_auth.sql`): Stores `admin`/`user` accounts and per-user `(device_id, lan_ip)` permissions.
- **`session`** (`database/migrations/003_session_login_at.sql`): Persistent PostgreSQL session store (`connect-pg-simple`) with `login_at` timestamp.
- **`display.*` views** (`database/migrations/004_time_display_views.sql`): Read-only views formatting all timestamps as `YYYY-MM-DD HH24:MI:SS` in `Asia/Ho_Chi_Minh`.
- **`002_timezone.sql`**: Standalone migration helper for upgrading legacy `timestamp without time zone` installations.

---

### Authentication, RBAC & HMAC Device Tickets

- **Password Security**: All user and device passwords use `bcryptjs` (cost `10`), with constant-time `SENSOR_API_KEY` verification (`crypto.timingSafeEqual`) and login brute-force rate limiting.
- **Role-Based Access Control**:
  - **`admin`**: Full visibility across all devices, bulk log deletion, device password management, user creation, `(device_id, lan_ip)` grant assignment, and approval of passwordless access requests.
  - **`user`**: Views only devices explicitly granted in `user_devices`; opens a local Device Dashboard either by entering the device password (receiving a 5-minute HMAC ticket) or by requesting real-time admin approval when no device password is set.

---

### Cloudflare Tunnel & Worker Gateway

- **`cloudflared`** (`docker-compose.yml`) exposes the internal `backend:3000` container securely to Cloudflare without opening inbound host ports.
- **`services/gateway`** is a Cloudflare Worker (`iot-env-monitor-sys`) bound to the tunnel's VPC Service (`env.IOT_BACKEND`), forwarding HTTPS requests with `X-Forwarded-Proto` and `X-Forwarded-Host` headers so secure cookies and ESP32 HTTPS `POST /sensor` telemetry work seamlessly over the public domain.

---

## Dashboards

### Embedded Device Dashboard

Located in `firmware/data/` and served directly by the ESP32-S3:

- Real-time temperature, humidity, soil moisture, composite status banner, and live Chart.js history (`5s` / `15s` intervals, with offline canvas fallback).
- Instant `ON`/`OFF` and `AUTO`/`MANUAL` pump controls synchronized via WebSocket.
- Settings modal for switching/adding Wi-Fi networks and updating the backend `SENSOR_API_URL` (`/server.json`).

### Central Admin Dashboard

Located in `services/backend/public/admin/`:

- Polls `/admin/api/devices` every `5 s` to display multi-device telemetry cards, live online/countdown/offline indicators, and summary counters.
- Provides modals for device password verification/management, real-time access-request approval notifications, account creation, and granular per-LAN-IP device permission assignment.

---

## TinyML Training Pipeline

Requires **Python 3.12+**:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r ml/requirements.txt
python ml/train_export.py
```

`ml/train_export.py`:

1. Generates `21,000` labeled samples (`16,000` boundary-grid noisy samples + `5,000` uniform random samples) aligned with `risk_policy.h` → `ml/data/dataset.csv`.
2. Trains `Input(3) → Dense(32, ReLU) → Dense(16, ReLU) → Dense(3, Softmax)` with early stopping.
3. Converts to unquantized float32 TFLite, verifies schema v3 operator compatibility (`FULLY_CONNECTED` v1, `SOFTMAX` v1) and numerical equivalence, and writes both `ml/models/dht_risk_model.tflite` and `firmware/include/dht_risk_model.h`.

---

## Device Utility Tools

`tools/device/pull_wifi_info.py` dumps the ESP32-S3 LittleFS partition (`0x670000`, size `0x180000` on `default_8MB.csv`) via `esptool`, mounts it with `littlefs-python`, and prints `/info.dat` + `/wifi_list.json` (or exports merged JSON via `--out`):

```bash
pip install -r tools/device/requirements.txt
python tools/device/pull_wifi_info.py --port /dev/ttyACM0
```

---

## Installation & Deployment

### 1. Configure Secrets

```bash
cp .env.example .env
cp firmware/include/secrets.h.example firmware/include/secrets.h
```

Fill in strong values in `.env` (`DB_PASS`, `SESSION_SECRET`, `SENSOR_API_KEY`, `ADMIN_PASSWORD`, `CLOUDFLARE_TUNNEL_TOKEN`) and matching `SENSOR_API_KEY`, `SENSOR_API_URL`, and `DEVICE_HTTP_PASS` in `firmware/include/secrets.h`. Both files are excluded by `.gitignore`.

### 2. Start Backend, PostgreSQL & Tunnel (Docker Compose)

```bash
docker compose up -d --build
```

On first initialization, PostgreSQL automatically runs `base.sql`, `001_auth.sql`, `003_session_login_at.sql`, and `004_time_display_views.sql`, and the backend seeds the initial admin account from `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

### 3. Deploy Cloudflare Worker Gateway (Optional)

```bash
cd services/gateway
npm ci
npm run deploy
```

### 4. Build & Flash ESP32-S3 Firmware (PlatformIO)

```bash
# Compile and flash firmware
pio run -e yolo_uno --target upload

# Build and flash LittleFS web assets (firmware/data/)
pio run -e yolo_uno --target uploadfs

# Monitor serial output (115200 baud)
pio device monitor
```

---

## Libraries & Runtime Versions

- **Firmware (`platformio.ini`, `espressif32@7.1.3`)**:
  - `TensorFlowLite_ESP32` (`firmware/lib/TensorFlowLite_ESP32`) — TensorFlow Lite Micro standalone clean engine
  - `ESPAsyncWebServer@3.12.1`
  - `bblanchon/ArduinoJson@7.4.3`
  - `ayushsharma82/ElegantOTA@4.0.0`
  - `adafruit/Adafruit NeoPixel@1.15.5`
  - `robtillaart/DHT20@0.3.3`
  - `LiquidCrystal_I2C` (`firmware/lib/lcd_i2c`)
- **Backend (`services/backend`, Node.js `26.12.0`, PostgreSQL `18.6`)**:
  - `express@^5.3.0`, `express-session@^1.19.0`, `connect-pg-simple@^10.0.0`, `pg@^8.23.1`, `bcryptjs@^3.0.4`
- **Gateway (`services/gateway`)**:
  - `wrangler@^4.86.0`
- **ML Pipeline (`ml/requirements.txt`, Python `3.12`)**:
  - `numpy==2.5.4`, `tensorflow==2.21.0`
