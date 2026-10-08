# ESP32-S3 IoT Environmental Monitoring System

A real-time IoT environmental monitoring system running on the **ESP32-S3 (Yolo Uno)** microcontroller. The system integrates multi-sensor data acquisition, multi-channel hardware alerting, automatic pump control, on-device TinyML inference, an embedded web server, and a Node.js/PostgreSQL backend with an Admin Dashboard for managing multiple devices.

---

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Hardware](#hardware)
- [Directory Structure](#directory-structure)
- [ESP32-S3 Firmware](#esp32-s3-firmware)
  - [FreeRTOS Tasks](#freertos-tasks)
  - [SharedContext](#sharedcontext)
  - [Synchronization Mechanisms](#synchronization-mechanisms)
  - [Risk Classification Logic](#risk-classification-logic)
  - [TinyML](#tinyml)
  - [Wi-Fi and Embedded Web Server](#wi-fi-and-embedded-web-server)
  - [Pump Control](#pump-control)
  - [LittleFS](#littlefs)
  - [Factory Reset](#factory-reset)
- [Node.js Backend](#nodejs-backend)
  - [API Endpoints](#api-endpoints)
  - [PostgreSQL Database](#postgresql-database)
  - [Authentication and Authorization](#authentication-and-authorization)
- [Frontend](#frontend)
  - [Device Dashboard (embedded on ESP32)](#device-dashboard-embedded-on-esp32)
  - [Admin Dashboard (Node.js)](#admin-dashboard-nodejs)
- [ML Pipeline](#ml-pipeline)
- [Utility Scripts](#utility-scripts)
- [Installation and Deployment](#installation-and-deployment)
- [Security Notes](#security-notes)
- [Libraries Used](#libraries-used)

---

## Overview

The project monitors three environmental parameters — **temperature**, **air humidity**, and **soil moisture** — on a 5-second cycle. Each cycle:

1. Data is displayed on a **16×2 LCD screen**, showing temperature, air humidity, soil moisture, and system status.
2. A **single LED (GPIO48)** blinks at a rate that reflects the temperature risk level.
3. A **NeoPixel WS2812B (GPIO45)** changes color to reflect the air humidity risk level — updated only when the state changes (event-driven).
4. The **pump (GPIO6)** turns on/off automatically based on soil moisture thresholds, or is controlled manually from the Dashboard.
5. A **TinyML model (TensorFlow Lite Micro)** classifies the composite risk level directly on-chip.
6. Data is pushed via **WebSocket** to the embedded Device Dashboard and sent via **HTTP POST** to the Node.js/PostgreSQL backend.

---

## System Architecture

```
┌─────────────────────────────────────────────────────┐
│                  ESP32-S3 (Yolo Uno)                │
│                                                     │
│  ┌──────────────┐    ┌────────────────────────────┐ │
│  │  FreeRTOS    │    │       SharedContext        │ │
│  │  Tasks       │◄──►│  temperature / humidity    │ │
│  │              │    │  soilMoisture / ledState   │ │
│  │ temp_humi    │    │  neoState / lcdState       │ │
│  │ led_blinky   │    │  mlStatus / mlRollAcc      │ │
│  │ neo_blinky   │    │  timestampReal / Us        │ │
│  │ task_pump    │    │  dbTriggerSource           │ │
│  │ tiny_ml_task │    │  mutexContext              │ │
│  │ task_database│    │  sem{LED/Neo/LCD/DB}Update │ │
│  │ Task_BOOT    │    └────────────────────────────┘ │
│  └──────────────┘                                   │
│                                                     │
│  LittleFS: /info.dat, /wifi_list.json, web assets   │
│  ESPAsyncWebServer (port 80) + WebSocket (/ws)      │
│  ElegantOTA (/update)                               │
└────────────────┬────────────────────────────────────┘
                 │ HTTP POST /sensor  (port 3000)
                 │ WebSocket ws://device_ip/ws
                 ▼
┌─────────────────────────────────────────────────────┐
│              Node.js Backend (port 3000)            │
│  Express.js + express-session (8 hours)             │
│  PostgreSQL: iot_db                                 │
│   ├── sensor_logs (13 columns)                      │
│   ├── system_users (admin / user)                   │
│   └── device_credentials                            │
│  Admin Dashboard (/admin) — multi-device management │
└─────────────────────────────────────────────────────┘
```

---

## Hardware

| Component                | GPIO / Interface                              | Role                                                   |
| ------------------------ | --------------------------------------------- | ------------------------------------------------------ |
| ESP32-S3 (Yolo Uno)      | —                                            | Central microcontroller running FreeRTOS + TinyML      |
| DHT20 Sensor             | I2C: SDA=GPIO11, SCL=GPIO12                   | Measures temperature and air humidity                  |
| Soil Moisture Sensor     | ADC: GPIO2 (`SOIL_PIN = 2`)                 | Measures soil moisture; raw ADC [0–4095] → [0–100]% |
| 16×2 LCD                | I2C: address 0x27                             | Displays T / H / SM / system status                    |
| Onboard single LED       | GPIO48 (`LED_GPIO = 48`)                    | Blinks according to the temperature risk level         |
| NeoPixel WS2812B (1 LED) | GPIO45 (`NEO_PIN = 45`), NEO_GRB+NEO_KHZ800 | Changes color according to the air humidity risk level |
| Mini pump (via relay)    | GPIO6 (`PUMP_PIN = 6`)                      | Controls automatic/manual irrigation                   |
| BOOT button              | GPIO0 (`INPUT_PULLUP`)                      | Hold > 2 seconds to trigger factory reset              |

---

## Directory Structure

```
Internship_Project/
├── src/                         # C++ firmware for ESP32
│   ├── main.cpp                 # setup() / loop(), creates FreeRTOS tasks
│   ├── global.cpp               # Global variable definitions
│   ├── temp_humi_monitor.cpp    # Reads DHT20 + soil sensor, LCD, WebSocket
│   ├── led_blinky.cpp           # Single LED control task
│   ├── neo_blinky.cpp           # NeoPixel control task
│   ├── pump.cpp                 # Pump control task (AUTO/MANUAL)
│   ├── tinyml.cpp               # TensorFlow Lite Micro inference task
│   ├── task_database.cpp        # HTTP POST to backend task
│   ├── task_webserver.cpp       # ESPAsyncWebServer, WebSocket, embedded REST API
│   ├── task_wifi.cpp            # AP Mode / STA Mode / NTP / network switching
│   ├── task_check_info.cpp      # Manages /info.dat and /wifi_list.json (LittleFS)
│   ├── task_handler.cpp         # Handles WebSocket messages from clients
│   ├── task_toogle_boot.cpp     # Factory reset via BOOT button (GPIO0)
│   └── serial_log.cpp           # Mutex-protected Serial output
├── include/
│   ├── global.h                 # SharedContext struct, extern global variable declarations
│   ├── risk_label.h             # Risk classification functions and safety interlock
│   ├── dht_anomaly_model.h      # TFLite model embedded as a C byte array
│   ├── project_includes.h       # Common include aggregation
│   └── *.h                      # Header files for each module
├── data/
│   └── wifi_info.json           # Wi-Fi list (exported by pull_wifi_info.py)
├── ml/
│   ├── train_export.py          # Training and TFLite export script
│   ├── dataset.csv              # Synthetic training dataset (21,000 rows)
│   ├── dht_risk_model.tflite    # Trained TFLite model
│   └── requirements.txt         # tensorflow, numpy
├── BE/                          # Node.js Backend
│   ├── index.js                 # Express server, REST API, session management
│   ├── admin_static/            # Admin Dashboard (HTML/CSS/JS)
│   └── login_static/            # Login page
├── FE/                          # Device Dashboard (uploaded to LittleFS)
│   ├── dashboard.html
│   ├── dashboard.css
│   └── dashboard.js
├── DB/
│   ├── DB.sql                   # Creates database, sensor_logs table, device_credentials table
│   └── auth_migration.sql       # Creates system_users table and default accounts
├── scripts/
│   ├── pull_wifi_info.py        # Reads /wifi_list.json from ESP32 flash to the host machine
│   ├── split_libs.ps1           # Utility to split libraries during build
│   └── README_split_libs.md     # Documentation for split_libs
├── boards/
│   └── yolo_uno.json            # Board definition for PlatformIO
└── platformio.ini               # PlatformIO build configuration
```

> **Important:** `data_dir = FE` in `platformio.ini` means that **only the contents of the `FE/` directory** are uploaded to LittleFS via `pio run --target uploadfs`. The `data/wifi_info.json` file is not automatically uploaded. To load the Wi-Fi list onto the device, copy this file into `FE/` and rename it to `wifi_list.json` before running the filesystem upload command.

---

## ESP32-S3 Firmware

The entire firmware is developed using the **Arduino Framework on PlatformIO**, running on the **FreeRTOS** scheduler integrated into the ESP32-S3.

**AP Mode credentials** (defined in `platformio.ini`):

- SSID: `ESP32 LOCAL`
- Password: `12345678`

### FreeRTOS Tasks

`setup()` initializes `SharedContext` and then creates 7 tasks, all at priority 2:

| Task                  | Stack (words) | Parameter | Description                                                                                      |
| --------------------- | ------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `temp_humi_monitor` | 2048          | ctx       | Reads DHT20 + soil sensor every 5 seconds, updates SharedContext, LCD, and pushes WebSocket data |
| `led_blinky`        | 2048          | ctx       | Blinks LED GPIO48 according to`ledState`                                                       |
| `neo_blinky`        | 2048          | ctx       | Updates NeoPixel GPIO45 color when`semNeoUpdate` is received                                   |
| `task_pump`         | 2048          | ctx       | Controls pump GPIO6 every 100 ms (AUTO or MANUAL mode)                                           |
| `tiny_ml_task`      | 8192          | ctx       | Runs TFLite Micro inference every 5 seconds and tracks`mlRollAcc`                              |
| `task_database`     | 4096          | ctx       | Sends HTTP POST to backend with 200 ms debounce                                                  |
| `Task_Toogle_BOOT`  | 4096          | NULL      | Monitors BOOT button GPIO0; triggers factory reset if held > 2 seconds                           |

**Responsibilities of `loop()`:**

1. Checks the `g_wifiSwitchFlag` flag → calls `Wifi_switch_to()` to switch Wi-Fi networks without restarting.
2. Calls `check_info_File(1)` — if an SSID is saved but `Wifi_reconnect()` fails → calls `Webserver_stop()`.
3. Calls `Webserver_reconnect()` — restarts the web server if it is stopped; this function also calls `ElegantOTA.loop()` internally to handle OTA updates.

> **Note:** `ElegantOTA.loop()` is called **inside** `Webserver_reconnect()`, not as a standalone call in `loop()`.

---

### SharedContext

The central data structure shared between all tasks (defined in `include/global.h`):

```cpp
struct SharedContext {
    float temperature;           // °C, -1 if NaN
    float humidity;              // %, -1 if NaN
    int   soilMoisture;          // % [0–100], mapped from ADC [0–4095]
    int   soilRaw;               // Raw ADC value
    int   ledState;              // 1=Normal / 2=Warning / 3=Critical (temperature)
    int   neoState;              // 1=Normal / 2=Warning / 3=Critical (air humidity)
    int   lcdState;              // 1/2/3, computed by risk_final_safety_label()
    int   mlPredicted;           // TinyML predicted label (1/2/3)
    float mlConfidence;          // Highest Softmax probability
    char  mlStatus[16];          // "Normal" / "Warning" / "Critical" / "Mismatch"
    float mlRollAcc;             // Cumulative rolling accuracy (%), accumulated over the entire session
    time_t      timestampReal;   // Seconds since epoch (NTP), 0 if not synchronized
    suseconds_t timestampRealUs; // Microseconds part of the NTP timestamp
    char  dbTriggerSource[8];    // "sensor" or "pump"
    // FreeRTOS handles
    SemaphoreHandle_t mutexContext;
    SemaphoreHandle_t semLEDUpdate;
    SemaphoreHandle_t semNeoUpdate;
    SemaphoreHandle_t semLCDUpdate;
    SemaphoreHandle_t semDBUpdate;
};
```

---

### Synchronization Mechanisms

| Mechanism                  | Type             | Purpose                                                                                                               |
| -------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `mutexContext`           | Mutex            | Protects all sensor data and state fields within SharedContext                                                        |
| `xMutexPumpControl`      | Mutex            | Independently protects pump control variables (`global_pump_state`, `pump_manual_control`, `pump_manual_state`) |
| `semLEDUpdate`           | Binary Semaphore | Signaled by`temp_humi_monitor` when `ledState` changes → `led_blinky` immediately updates blink frequency      |
| `semNeoUpdate`           | Binary Semaphore | Same mechanism, for the NeoPixel                                                                                      |
| `semLCDUpdate`           | Binary Semaphore | Same mechanism, for the LCD status                                                                                    |
| `semDBUpdate`            | Binary Semaphore | Signaled after each sensor read cycle or when the pump state changes →`task_database` sends an HTTP POST           |
| `serialLogLock / Unlock` | Dedicated Mutex  | Prevents tasks from interleaving their Serial output                                                                  |

---

### Risk Classification Logic

All thresholds are defined in `include/risk_label.h`.

**Single LED — based on temperature (`risk_led_state_from_temperature`):**

| State    | Temperature            | Duration per phase (HIGH/LOW) |
| -------- | ---------------------- | ----------------------------- |
| Normal   | 15°C – 25°C         | 1000 ms                       |
| Warning  | 10–15°C or 25–30°C | 500 ms                        |
| Critical | < 10°C or > 30°C     | 100 ms                        |

> **Note:** Each phase (HIGH or LOW) is held for the duration listed above. The full blink cycle is approximately twice that: ~2000 ms / ~1000 ms / ~200 ms. If a `semLEDUpdate` signal is received while waiting, the LED turns off immediately and the loop restarts to adopt the new frequency.

**NeoPixel — based on air humidity (`risk_neo_state_from_humidity`):**

| State    | Air Humidity       | Color                   |
| -------- | ------------------ | ----------------------- |
| Normal   | 60% – 70%         | Green`(0, 255, 0)`    |
| Warning  | 50–60% or 70–80% | Yellow`(255, 255, 0)` |
| Critical | < 50% or > 80%     | Red`(255, 0, 0)`      |

> The NeoPixel is initialized to the color corresponding to `neoState = 1` (green) before entering the main loop. Inside the loop, the task waits on `semNeoUpdate` with `portMAX_DELAY` — color is updated only when a signal is received, with no continuous polling.

**Soil Moisture (`risk_soil_state_from_moisture`):**

| State    | Soil Moisture      |
| -------- | ------------------ |
| Normal   | 30% – 40%         |
| Warning  | 25–30% or 40–45% |
| Critical | < 25% or > 45%     |

**LCD and Database — composite label (`risk_final_safety_label`):**

**Step 1 — Hard Safety Interlock:** If `T ≥ 40°C` OR `H ≥ 90%` OR `soil < 15%` OR `soil > 60%` → returns Critical immediately, bypassing Step 2.

**Step 2 — Piecewise linear penalty algorithm** (`risk_pure_mathematical_label`):

```
r = 0.35 × penalty(T) + 0.20 × penalty(H) + 0.45 × penalty(soil)

r ≤ 3.0  → Normal  (label = 1)
r ≤ 6.5  → Warning (label = 2)
r > 6.5  → Critical (label = 3)
```

**Optimal zone** (penalty = 0): T∈[15,25]°C, H∈[60,70]%, soil∈[30,40]%.

---

### TinyML

A 3-class classifier (Normal/Warning/Critical) running on the ESP32-S3 via **TensorFlow Lite Micro**.

**Network architecture:** `Input(3) → Dense(32, ReLU) → Dense(16, ReLU) → Dense(3, Softmax)`

**Tensor arena:** 16 KiB (`kTensorArenaSize = 16 * 1024`), statically allocated.

**Data type:** float32 — no quantization (`converter.optimizations = []`).

**Input:** `[temperature, humidity, soil_moisture]` as float32.

**Output:** probability vector `[p0, p1, p2]` — `predicted = argmax(output) + 1` (maps index 0..2 → label 1..3).

**On-device evaluation:**

- `expected` = `risk_pure_mathematical_label(T, H, S)` — the safety interlock is **not** applied here.
- `mlRollAcc = correct / inferences × 100%` — accumulated across the entire running session.
- **`mlStatus` determination:**
  - If the safety interlock triggers (`T ≥ 40 OR H ≥ 90 OR soil < 15 OR soil > 60`) → `mlStatus = "Critical"` regardless of predicted/expected.
  - Otherwise, if `predicted == expected` → `mlStatus` = the corresponding state name (`"Normal"` / `"Warning"` / `"Critical"`).
  - If `predicted ≠ expected` and no safety trigger → `mlStatus = "Mismatch"`.

**Serial log per cycle (115200 baud):**

```
TinyML T=XX.X°C H=XX.X% S=XX% | rule=N pred=N | <status> | p=[p0,p1,p2] | Xms | roll_acc=XX.X% (correct/total)
```

**Inference time** is measured using `millis()` before and after `Invoke()`.

**Retraining:** run `ml/train_export.py` → generates `ml/dht_risk_model.tflite` → automatically converted to `include/dht_anomaly_model.h` for embedding into the firmware.

---

### Wi-Fi and Embedded Web Server

**Boot sequence:**

```
setup()
  └── check_info_File(false)
        ├── LittleFS.begin(true)
        ├── Reads /info.dat → retrieves WIFI_SSID, WIFI_PASS, STA_IP
        ├── WIFI_SSID is empty → startAP()   [AP Mode: "ESP32 LOCAL" / "12345678"]
        └── WIFI_SSID is saved → loop() → Wifi_reconnect() → startSTA()
                └── Connection successful:
                      ├── Save_sta_ip_File() → updates STA_IP in /info.dat
                      ├── configTime(7*3600, 0, "pool.ntp.org", "time.nist.gov")
                      └── xSemaphoreGive(xBinarySemaphoreInternet)
```

STA connection timeout: **10 seconds** (`millis() - start < 10000`).

**Backend target URL configuration (`SENSOR_API_URL`):**

The ESP32 reads the backend server URL (`g_sensorApiUrl`) from `SENSOR_API_URL` (defined in `secrets.h`), which supports HTTPS domains or Cloudflare Tunnels. If `/server.json` exists in LittleFS (configurable via the web settings), its `url` value overrides the default. `task_database` automatically appends `/sensor` and sends data via HTTP/HTTPS POST.

**Switching Wi-Fi networks without restarting** (`POST /api/wifi-switch`):

1. Writes `g_wifiSwitchSSID`, `g_wifiSwitchPass`, and sets `g_wifiSwitchFlag = true`.
2. `loop()` detects the flag → calls `Wifi_switch_to()`.
3. `Wifi_switch_to()` calls `Save_wifi_to_list()` + `Save_info_NoRestart()` to persist the new network, then `WiFi.disconnect(true)` → delay 500 ms → `startSTA()` (no `ESP.restart()`).

**Wi-Fi list management (`/wifi_list.json`):** The most recently added SSID is inserted at the beginning of the list; if the SSID already exists, only its password is updated in place.

**Embedded REST API (port 80):**

| Endpoint                       | Method    | Description                                                           |
| ------------------------------ | --------- | --------------------------------------------------------------------- |
| `/`                          | GET       | Serves`dashboard.html` from LittleFS                                |
| `/ws`                        | WebSocket | Pushes sensor data every 5 seconds; receives control commands         |
| `/api/status`                | GET       | Returns`{"mqtt_connected": true, "is_ap_mode": bool}`               |
| `/toggle-pump?state=ON\|OFF`  | GET       | Manually turns the pump on/off (toggles if no parameter is given)     |
| `/set-mode?mode=AUTO\|MANUAL` | GET       | Switches the pump operating mode                                      |
| `/api/wifi-list`             | GET       | Returns the saved Wi-Fi network list from`/wifi_list.json`          |
| `/api/wifi-switch`           | POST      | Switches to a new Wi-Fi network without restarting (`{ssid, pass}`) |
| `/update`                    | GET/POST  | ElegantOTA — over-the-air firmware update via browser                |

**WebSocket payload from device** (every 5 seconds):

```json
{"temperature": 25.30, "humidity": 65.20, "soil_moisture": 35, "lcd_state": 1}
```

**WebSocket pump state payload:**

```json
{"pump_state": "ON", "pump_mode": "MANUAL"}
```

When a new WebSocket client connects, the server immediately sends the current pump state to synchronize the UI.

---

### Pump Control

The `task_pump` task runs every **100 ms** (`vTaskDelay(100 / portTICK_PERIOD_MS)`):

**AUTO mode** (`pump_manual_control = false`):

- Pump turns on when `soilMoisture < PUMP_SOIL_THRESHOLD` (= **5%**).
- Pump turns off when `soilMoisture ≥ 5%`.

**MANUAL mode** (`pump_manual_control = true`):

- Pump state follows `pump_manual_state`, set via the `/toggle-pump` endpoint.

When the pump state changes (`new_state ≠ last_reported_state`):

1. Updates `global_pump_state` under `xMutexPumpControl`.
2. Pushes a WebSocket message to all connected clients.
3. Sets `dbTriggerSource = "pump"`, sets `g_pumpEventPending = true`, and signals `semDBUpdate` to log the event to PostgreSQL.

---

### LittleFS

The internal flash filesystem on the ESP32-S3, mounted at boot via `LittleFS.begin(true)`.

| File                | Content                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `/info.dat`       | JSON:`{"WIFI_SSID": "...", "WIFI_PASS": "...", "STA_IP": "..."}`                          |
| `/wifi_list.json` | JSON array:`[{"ssid": "...", "pass": "...", "sta_ip": "..."}, ...]` — newest entry first |
| `/dashboard.html` | Device Dashboard HTML                                                                       |
| `/dashboard.css`  | Device Dashboard stylesheet                                                                 |
| `/dashboard.js`   | Device Dashboard logic (WebSocket, Chart.js, Leaflet)                                       |

**Structure of a single entry in `/wifi_list.json`:**

```json
{
  "ssid": "NetworkName",
  "pass": "password",
  "sta_ip": "192.168.1.x"
}
```

The `sta_ip` field is saved automatically when the device successfully connects to the corresponding network.

---

### Factory Reset

Hold the **BOOT button (GPIO0)** continuously for more than **2 seconds**:

- Deletes `/info.dat` from LittleFS.
- Writes `{}` to `/wifi_info.json` on LittleFS (note: this targets `/wifi_info.json`, not `/wifi_list.json`).
- Calls `ESP.restart()` → device reboots into AP Mode.

> **Important:** Factory reset **does not delete `/wifi_list.json`**. All saved Wi-Fi networks remain intact after the reset. Only the current connection configuration (stored in `/info.dat`) is erased.

---

## Node.js Backend

Located in the `BE/` directory, running on **port 3000**.

```bash
cd BE
npm install
node index.js
```

### API Endpoints

**Device data:**

| Endpoint                                    | Method | Auth      | Description                                            |
| ------------------------------------------- | ------ | --------- | ------------------------------------------------------ |
| `/sensor`                                 | POST   | —        | ESP32 submits sensor data; INSERTs into`sensor_logs` |
| `/admin/api/devices`                      | GET    | Logged in | Device list (most recent record per device)            |
| `/admin/api/devices/:id/history?limit=60` | GET    | Logged in | Device history, up to 200 records                      |
| `/admin/api/devices/:id`                  | DELETE | Admin     | Deletes all data for the device                        |

**Device credentials:**

| Endpoint                            | Method | Auth      | Description                                          |
| ----------------------------------- | ------ | --------- | ---------------------------------------------------- |
| `/admin/api/devices/:id/verify`   | POST   | Logged in | Verifies the device password (`{password}`)        |
| `/admin/api/devices/:id/password` | POST   | Admin     | Sets or updates the device password (`{password}`) |

**System accounts:**

| Endpoint                 | Method   | Auth  | Description                                                        |
| ------------------------ | -------- | ----- | ------------------------------------------------------------------ |
| `/login`               | GET/POST | —    | Login page / login handler (rate-limited)                          |
| `/register`            | POST     | —    | Disabled; accounts are created by an admin                         |
| `/logout`              | POST     | —    | Destroys the session                                               |
| `/api/me`              | GET      | —    | Returns`{loggedIn, username, role}`                              |
| `/admin/api/users`     | GET      | Admin | Lists all system accounts                                          |
| `/admin/api/users`     | POST     | Admin | Creates a new account (`{username, password, role}`)             |
| `/admin/api/users/:id` | DELETE   | Admin | Deletes an account (cannot delete the currently logged-in account) |

---

### PostgreSQL Database

**Database:** `iot_db` — **User / password:** from `.env` (`DB_USER`, `DB_PASS`)

**`sensor_logs` table (13 columns):**

| Column             | Type               | Description                                                                     |
| ------------------ | ------------------ | ------------------------------------------------------------------------------- |
| `id`             | INTEGER (identity) | Auto-incrementing primary key                                                   |
| `timestamp_real` | timestamp          | Sensor measurement time (from NTP), NULL if not synchronized                    |
| `timestamp_up`   | timestamp NOT NULL | Time recorded by`gettimeofday()` immediately before sending the HTTP POST     |
| `temperature`    | text               | Example:`"25.30°C"`                                                          |
| `humidity`       | text               | Example:`"65.20%"`                                                            |
| `soil_moisture`  | text               | Example:`"35%"` (formatted as `%02d%%`)                                     |
| `PUMP_state`     | text               | `"ON"` or `"OFF"`                                                           |
| `MODE_state`     | text               | `"AUTO"` or `"MANUAL"`                                                      |
| `Message`        | text               | `"Normal"` / `"Warning"` / `"Critical"`                                   |
| `Score`          | text               | `mlRollAcc` as a percentage, e.g. `"97.50%"` or `"100%"`                  |
| `device_id`      | text               | LAN IP address of the ESP32 device                                              |
| `latency`        | int                | End-to-end latency in**microseconds**: `timestamp_up − timestamp_real` |
| `trigger_source` | text               | `"sensor"` or `"pump"`                                                      |

**`device_credentials` table:** `device_id (PK)`, `password` — access password for each device.

**`system_users` table:** `id`, `username (UNIQUE)`, `password`, `role CHECK('admin','user')`, `created_at`.

**Database initialization:**

```bash
psql -U postgres -f DB/DB.sql
psql -U postgres -d iot_db -f DB/auth_migration.sql
```

**DB write debounce mechanism** (in `task_database.cpp`):

- Minimum interval between two consecutive POSTs with the same trigger source: **200 ms**.
- A `"sensor"` event is suppressed if `g_pumpEventPending = true` or if the most recent pump POST occurred less than 200 ms ago — **pump events always take priority**.
- After sending a POST for a pump event, `g_pumpEventPending` is reset to `false`.

**Timestamp update after each POST:**

- `g_lastDBPostMs_pump` or `g_lastDBPostMs_sensor` is updated via `millis()` after the POST succeeds or fails.

**Latency** = `gettimeofday()` at transmission time (in `task_database`) − `gettimeofday()` at sensor read time (in `temp_humi_monitor`), in **microseconds (µs)**.

---

### Authentication and Authorization

- **Session:** `express-session`, lifetime **8 hours**, `httpOnly` cookie, secret from `SESSION_SECRET`.
- **First admin:** created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` when `system_users` is empty. Additional users are created by an admin.
- **Passwords** are stored with bcrypt. Legacy plaintext values are rehashed on the next successful login.

**Authorization matrix:**

| Feature                          | Admin                     | User                              |
| -------------------------------- | ------------------------- | --------------------------------- |
| View device list                 | ✅                        | ✅                                |
| View device history              | ✅                        | ✅                                |
| Access Device Dashboard directly | ✅ (no password required) | ✅ (device password required)     |
| Device has no password set       | ✅ Can set a new password | ✅ Direct access without password |
| Delete device                    | ✅                        | ❌                                |
| Set device password              | ✅                        | ❌                                |
| Manage system accounts           | ✅                        | ❌                                |
| Select and bulk-delete devices   | ✅                        | ❌                                |

**Session timeout on Device Dashboard:** Users are redirected back after **5 minutes** (tracked via the URL parameter `?session_start=HH:MM:SS`).

---

## Frontend

### Device Dashboard (embedded on ESP32)

Served from LittleFS at `http://<device_ip>/`. Source code in `FE/`.

**Features:**

- Displays temperature, air humidity, and soil moisture in real time via WebSocket.
- Sensor value colors map exactly to risk thresholds from `risk_label.h`: Normal (green), Warning (orange), Critical (red).
- Special case: displays `"100%"` when `humidity ≥ 99.95`.
- Historical line chart (Chart.js, up to 60 data points, 5 s or 15 s interval — user-selectable).
- Location map (Leaflet + OpenStreetMap) with default coordinates (12.6951778, 108.057041).
- Pump status badge (ON/OFF) and mode badge (AUTO/MANUAL) with Toggle buttons.
- Composite environment status notification derived from `lcd_state`.
- Wi-Fi configuration modal (sends via WebSocket or `/api/wifi-switch`).
- "The device is in AP Mode" overlay when `/api/status` reports `is_ap_mode: true`.
- WebSocket **automatically reconnects after 2 seconds** on connection loss.
- Fallback canvas chart when Chart.js cannot be loaded (offline mode).

### Admin Dashboard (Node.js)

Served at `http://<server>:3000/admin`. Source code in `BE/admin_static/`.

**Features:**

- Displays a card grid; each card represents one device, auto-refreshed every **5 seconds** (polling `/admin/api/devices`).
- Each card establishes a **direct WebSocket connection** to `ws://<device_id>/ws` for real-time data.
- **Online/Offline detection mechanism:**
  - After `STALE_DIFF_MS = 10,000 ms` with no new data → a countdown begins.
  - After an additional `COUNTDOWN_SECONDS = 5 seconds` → transitions to Offline state.
  - The Offline state displays the time elapsed since going offline, rounded down to the nearest **multiple of 30 seconds**.
- Sensor value colors map exactly to the thresholds defined in `risk_label.h`.
- **Admin:** card selection checkboxes, action bar, bulk device deletion.
- **User:** all selection/deletion features are hidden; device password must be entered before accessing the Device Dashboard.
- Real-time clock and summary statistics (total / online / offline).

---

## ML Pipeline

The script `ml/train_export.py` executes the full pipeline:

```bash
pip install -r ml/requirements.txt
python ml/train_export.py
```

**Steps:**

1. **Dataset generation** (`build_dataset`):

   - Grid scan with `np.linspace`: T∈[5,50]°C × H∈[20,100]% × S∈[0,100]% (20×20×20×2 = 16,000 Gaussian-noised samples).
   - 5,000 uniformly distributed random samples.
   - Total: **21,000 rows** (consistent with `dataset.csv`).
   - Labels assigned automatically by `final_label()` — synchronized with `risk_label.h`.
   - Output written to `ml/dataset.csv`.
2. **Training:**

   - Split: 85% train / 15% validation.
   - Optimizer: Adam (lr=0.002), batch size=64, max epochs=80.
   - EarlyStopping: monitors `val_accuracy`, patience=15, restores best weights.
3. **Model export:**

   - TFLite float32, no quantization (`converter.optimizations = []`) → `ml/dht_risk_model.tflite`.
   - Converted to a C byte array → `include/dht_anomaly_model.h` for embedding into the firmware.

**Outputs:**

- `ml/dataset.csv` — training dataset.
- `ml/dht_risk_model.tflite` — TFLite model file.
- `include/dht_anomaly_model.h` — model pre-embedded in the firmware.

---

## Utility Scripts

### `scripts/pull_wifi_info.py`

Reads the contents of `/wifi_list.json` from the ESP32 flash and saves it to the host machine at `data/wifi_info.json`. It also reads `/info.dat` to retrieve the current IP address (`STA_IP`) and the connected SSID, then updates the `sta_ip` field for the matching SSID in the output list.

**Installation:**

```bash
pip install esptool littlefs-python
```

**First run** (to determine the LittleFS partition offset and size):

```bash
# Find the default_8MB.csv file in PlatformIO (PowerShell):
Get-ChildItem -Path "$env:USERPROFILE\.platformio" -Recurse -Filter "default_8MB.csv" | Select-Object FullName

# Run with the LittleFS partition offset/size:
python scripts/pull_wifi_info.py --port COM7 --offset 0x670000 --size 0x180000
```

**Subsequent runs** (after the default configuration has been confirmed):

```bash
python scripts/pull_wifi_info.py --port COM7
```

### `scripts/split_libs.ps1`

A PowerShell utility that splits the `lib/` directory into `lib_used/` (libraries currently in use) and `lib_unused/` (unused libraries) to reduce the tree size during builds. See `scripts/README_split_libs.md` for details.

---

## Installation and Deployment

### 1. ESP32-S3 Firmware

**Requirements:** PlatformIO IDE or CLI.

```bash
# Build and flash firmware
pio run --target upload

# Upload filesystem (Dashboard files to LittleFS)
# Note: data_dir = FE; only the contents of FE/ are uploaded
pio run --target uploadfs

# Open Serial Monitor (115200 baud)
pio device monitor
```

> **Note:** To load the Wi-Fi list onto the device, copy `data/wifi_info.json` into `FE/` as `wifi_list.json` before running `uploadfs`.

### 2. Retraining the TinyML Model (optional)

```bash
pip install -r ml/requirements.txt
python ml/train_export.py
# Then rebuild and re-flash the firmware to embed the new model
pio run --target upload
```

### 3. Node.js Backend

**Requirements:** Node.js ≥ 16, PostgreSQL running.

```bash
cp .env.example .env
# Edit .env: DB_PASS, SESSION_SECRET, SENSOR_API_KEY, ADMIN_PASSWORD

# Initialize the database (create DB_USER yourself; do not commit passwords)
psql -U postgres -f DB/DB.sql
psql -U postgres -d iot_db -f DB/auth_migration.sql

# Install dependencies and start
cd BE
npm install
node index.js
# Server running at http://localhost:3000
```

### 4. Access URLs

| URL                            | Description                               |
| ------------------------------ | ----------------------------------------- |
| `http://<device_ip>/`        | Device Dashboard (served from ESP32)      |
| `http://<device_ip>/update`  | ElegantOTA — firmware update via browser |
| `http://<server>:3000/login` | Admin login page                          |
| `http://<server>:3000/admin` | Admin Dashboard                           |

### 5. Initial Wi-Fi Configuration for the Device

1. Power on the ESP32 when no `/info.dat` exists → device broadcasts AP Mode (`ESP32 LOCAL`).
2. Connect a computer or phone to the AP Wi-Fi (password: `12345678`).
3. Open a browser → navigate to the Dashboard → Settings → enter SSID/Password → Save & Connect.
4. The device saves the credentials and restarts in STA Mode.

---

## Security Notes

> Copy `.env.example` to `.env` and `include/secrets.h.example` to `include/secrets.h`. Do not commit real passwords, `SESSION_SECRET`, or `data/wifi_info.json`.

> System and device passwords are stored with **bcrypt**. Existing plaintext hashes are upgraded on the next successful login. The first admin is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` when `system_users` is empty.

> `POST /sensor` requires header `X-Device-Key` matching `SENSOR_API_KEY`. ESP32 HTTP/WebSocket/OTA endpoints use HTTP Basic Auth from `DEVICE_HTTP_USER` / `DEVICE_HTTP_PASS`.

> Public `/register` is disabled. Login is rate-limited. `POST /sensor` rejects unsafe `device_id` values.

> ℹ️ **The `latency` column** in `sensor_logs` stores values in **microseconds (µs)**, not milliseconds.

> ℹ️ **Backend target URL:** The ESP32 sends sensor telemetry to `SENSOR_API_URL` (configured in `include/secrets.h` or overridden by `/server.json` via the web dashboard settings). Ensure the backend is reachable via this URL.

> ℹ️ **Factory reset** only deletes `/info.dat` and writes `{}` to `/wifi_info.json`. The Wi-Fi list in `/wifi_list.json` is **not deleted** by a factory reset.

---

## Libraries Used

**Firmware (PlatformIO — `platformio.ini`):**

- `ESPAsyncWebServer` (from GitHub: `me-no-dev/ESPAsyncWebServer`) — asynchronous web server
- `TensorFlowLite_ESP32` (`tanakamasayuki/TensorFlowLite_ESP32@1.0.0`) — TensorFlow Lite Micro
- `Adafruit NeoPixel` (`adafruit/Adafruit NeoPixel@^1.15.1`) — WS2812B LED control
- `DHT20` — temperature/humidity sensor driver
- `LiquidCrystal_I2C` — I2C LCD display driver
- `ArduinoJson` — JSON read/write (LittleFS, WebSocket)
- `ElegantOTA` — over-the-air firmware updates via browser

**Backend (`BE/package.json`):**

- `express@^5.2.1` — REST framework
- `express-session@^1.19.0` — session management
- `pg@^8.22.0` — PostgreSQL client
- `bcryptjs` — password hashing

**Frontend (CDN):**

- `Chart.js` — historical sensor line chart
- `Leaflet` + OpenStreetMap — location map
