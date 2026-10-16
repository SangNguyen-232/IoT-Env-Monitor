# Hướng Dẫn Triển Khai IoT System — Docker + WSL2 + Cloudflare Tunnel

## Kiến Trúc Tổng Quan

```
┌─────────────────────────────────────── Windows Host / Linux ──────────────────────────────────────────┐
│                                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                            Docker Desktop (WSL2 backend) / Docker Engine                        │  │
│  │                                                                                                 │  │
│  │  ┌───────────────────────────────────────────────────────────────────────────────────────────┐  │  │
│  │  │                            docker-compose network: iot_net (bridge)                       │  │  │
│  │  │                                                                                           │  │  │
│  │  │  ┌──────────────────────────┐    ┌─────────────────────────────┐    ┌──────────────────┐  │  │  │
│  │  │  │  container: iot_backend  │    │  container: iot_postgres    │    │ container:       │  │  │  │
│  │  │  │  Image: node:20-alpine   │◄──►│  Image: postgres:16-alpine  │    │ iot_cloudflared  │  │  │  │
│  │  │  │  Internal Expose: 3000   │    │  Port: 127.0.0.1:5433→5432  │◄──►│ Image:           │  │  │  │
│  │  │  │  Node.js / Express       │    │  DB: iot_db                 │    │ cloudflare/      │  │  │  │
│  │  │  │  DB_HOST: postgres       │    │  User: iot_user             │    │ cloudflared      │  │  │  │
│  │  │  │  TRUST_PROXY: "1"        │    │  Healthcheck: pg_isready    │    │ Tunnel token run │  │  │  │
│  │  │  │  Healthcheck: /api/me    │    │  Logging: 10m x 3           │    │ Logging: 5m x 2  │  │  │  │
│  │  │  └─────────────┬────────────┘    └─────────────────────────────┘    └─────────┬────────┘  │  │  │
│  │  │                │                                Volume: pgdata                │           │  │  │
│  │  │                └───────────────── http://backend:3000 ────────────────────────┘           │  │  │
│  │  └───────────────────────────────────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                  │ 127.0.0.1:5433                     │
│                                                                  ▼                                    │
│                                                      ┌─────────────────────────────┐                  │
│                                                      │  pgAdmin / psql (tuỳ chọn)  │                  │
│                                                      │  chỉ truy cập từ chính máy  │                  │
│                                                      └─────────────────────────────┘                  │
│                                                                                                       │
│  PlatformIO (VS Code) — build/flash firmware ESP32-S3 & nạp LittleFS (FE: Web nhúng)                  │
│                                                                                                       │
└───────────────────────────────────────────────────┬───────────────────────────────────────────────────┘
                                                    │ Cloudflare Zero Trust Tunnel
                                                    │ (Public HTTPS Domain / Ingress)
                                                    ▼
                             ┌─────────────────────────────────────────────┐
                             │       Cloudflare Global Edge Network        │
                             │       https://<your-subdomain>.domain       │
                             └──────────────┬──────────────────────────────┘
                                            │
               ┌────────────────────────────┴────────────────────────────┐
               │ HTTPS POST /sensor (X-Device-Key)                       │ HTTPS (Web Admin)
               ▼                                                         ▼
   ESP32-S3 (Bất kỳ mạng Wi-Fi nào)                           Admin / User Trình duyệt web
```

**Đặc điểm kiến trúc:**

- **Toàn bộ stack backend vận hành trong Docker**: Bao gồm PostgreSQL (`iot_postgres`), Node.js Express (`iot_backend`) và Cloudflare Tunnel client (`iot_cloudflared`) cùng giao tiếp nội bộ trong bridge network `iot_net`.
- **Cổng 3000 của backend được bảo vệ tối đa (`expose: 3000`)**: Không publish trực tiếp ra ngoài card mạng host/LAN. Chỉ có container `iot_cloudflared` kết nối tới backend theo địa chỉ `http://backend:3000` thông qua cầu nối mạng nội bộ Docker.
- **Dockerfile Backend tối ưu hóa và bảo mật**: Chạy trên nền `node:20-alpine`, cài đặt `tzdata` (múi giờ `Asia/Ho_Chi_Minh`), cài dependencies bằng `npm ci --omit=dev`, gán quyền sở hữu thư mục và thực thi server dưới tài khoản người dùng không đặc quyền `node` (`USER node`).
- **Cloudflare Tunnel chạy tự động dạng container**: Tự duy trì kết nối bảo mật ra internet bằng token `CLOUDFLARE_TUNNEL_TOKEN` từ Cloudflare Zero Trust Dashboard, không cần cài đặt ứng dụng hay mở terminal chạy lệnh thủ công trên máy host.
- **Hỗ trợ Reverse Proxy chuẩn (`TRUST_PROXY: "1"`)**: Express Backend tin tưởng IP thực từ header của Cloudflare gửi sang (`CF-Connecting-IP`), giải quyết triệt để vấn đề nhiều client qua tunnel bị trùng IP dẫn đến chặn nhầm Rate Limit (mã `429`).
- **PostgreSQL an toàn tuyệt đối**: Expose port `5433` duy nhất trên `127.0.0.1` của máy host (chỉ máy host mới kết nối được qua psql/pgAdmin, mạng ngoài hoàn toàn không thấy), dữ liệu lưu trữ bền vững trong Docker volume `pgdata`.
- **Phiên làm việc bền vững (Session in PostgreSQL)**: Session đăng nhập được lưu tại bảng `session` qua `connect-pg-simple`. Khởi động lại container backend hoàn toàn **không làm mất phiên đăng nhập** (thời hạn 8 giờ, thuộc tính cookie `secure: 'auto'` tự thích ứng HTTP/HTTPS qua proxy).
- **Cơ chế xác thực thiết bị và phân quyền nâng cao**:
  - *Thiết bị đã có mật khẩu*: Khi người dùng nhập đúng mật khẩu của thiết bị, backend cấp **Device Ticket** ký bằng `HMAC-SHA256` dựa trên `SENSOR_API_KEY` (hiệu lực 5 phút) chứa thông tin `device_id`, `lan_ip`, `expiresAt`.
  - *Thiết bị chưa có mật khẩu*: User gửi yêu cầu truy cập in-memory (`/access-request`) đến Admin. Admin nhận thông báo realtime trên giao diện Admin và bấm **Chấp nhận / Từ chối**.
  - *Quản lý phân tách cổng mạng*: Trang Admin phân biệt thiết bị dựa trên `card_key` (`device_id` + `lan_ip`), hỗ trợ hiển thị độc lập ngay cả khi có nhiều thiết bị chung địa chỉ MAC hoặc di chuyển IP.
- **Cơ chế WebSocket Auth Token trên ESP32**: Web Dashboard của ESP32 sau khi kết nối WebSocket `/ws` sẽ gọi API `/api/ws-token` lấy token ngẫu nhiên 32 ký tự hex (hiệu lực 30 giây) để xác thực handshake trước khi gửi/nhận lệnh điều khiển.
- **Hệ thống điều khiển bơm relay (GPIO10) bảo vệ nhiều lớp**:
  - Chế độ `AUTO`: Tự động bật khi độ ẩm đất < 25%, tắt khi ≥ 32%, chạy tối đa 60 giây và nghỉ cooldown 120 giây. Nếu sau 3 lần tưới liên tiếp độ ẩm không tăng tối thiểu 3%, hệ thống tự ngắt và khóa báo lỗi phần cứng (`auto_fault = true`). Khóa chỉ được gỡ khi độ ẩm đất tự phục hồi ≥ 32%.
  - Chế độ `MANUAL`: Bật/tắt chủ động từ Web Dashboard, tự ngắt tối đa sau 5 phút (300 giây) để chống quên tắt tràn nước.
- **Tối ưu hóa tài nguyên ghi log**: Docker-compose được cấu hình giới hạn kích thước log (`json-file`, max-size 10MB cho DB/Backend, 5MB cho Tunnel) chống tràn ổ đĩa cứng.

---

## Yêu Cầu Phần Mềm

| Phần mềm              | Phiên bản                    | Ghi chú                                                                        |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| Windows 10/11 / Linux   | 21H2 trở lên / Ubuntu 22.04+ | Hỗ trợ WSL2 (nếu dùng Windows) hoặc Linux native                           |
| WSL2                    | Tích hợp sẵn                | Backend engine cho Docker Desktop trên Windows                                 |
| Docker Desktop / Engine | 24.x trở lên                 | Khởi chạy cụm 3 container qua Docker Compose v2                              |
| VS Code + PlatformIO    | Mới nhất                     | Môi trường build, flash firmware C++ ESP32 & nạp LittleFS                   |
| Git                     | Mới nhất                     | Cần thiết để PlatformIO tải thư viện `ESPAsyncWebServer` từ GitHub            |
| Tài khoản Cloudflare    | Miễn phí                     | Dùng Cloudflare Zero Trust để tạo Tunnel lấy Token                             |
| Python                  | 3.11 hoặc 3.12               | Tuỳ chọn: Huấn luyện TinyML (`ml/`) và trích xuất Wi-Fi (`scripts/`)         |

---

# PHẦN 1 — CÀI ĐẶT MÔI TRƯỜNG

## Bước 1 — Cài WSL2 (Nếu dùng Windows)

Mở **PowerShell với quyền Administrator** (`Run as Administrator`) và chạy:

```powershell
wsl --install
```

Lệnh này sẽ:

- Bật tính năng Virtual Machine Platform và Windows Subsystem for Linux.
- Tải về bản phân phối Ubuntu mặc định.
- Thiết lập WSL2 làm engine ảo hóa mặc định.

**Sau khi hoàn tất → Khởi động lại máy tính (Restart Windows).**

Khi máy khởi động lại, cửa sổ Ubuntu sẽ bật lên để bạn đặt **Username** và **Password** cho Linux (tùy ý đặt, không ảnh hưởng đến mật khẩu Windows).

Kiểm tra trạng thái WSL2 bằng PowerShell:

```powershell
wsl --list --verbose
```

Output mong đợi:

```
  NAME      STATE           VERSION
* Ubuntu    Running         2
```

> Nếu cột `VERSION` là `1`, nâng cấp bằng lệnh: `wsl --set-version Ubuntu 2`

---

## Bước 2 — Cài Docker Desktop / Docker Engine

### Đối với Windows:

1. Tải bộ cài tại: https://www.docker.com/products/docker-desktop/
2. Mở file cài đặt, tích chọn mục:
   - ✅ **Use WSL 2 instead of Hyper-V (recommended)**
   - ✅ **Add shortcut to desktop**
3. Khởi động lại Windows khi được yêu cầu.
4. Mở Docker Desktop từ Start Menu, đợi thanh trạng thái góc trái dưới chuyển sang màu xanh lá: **"Engine running"**.

### Đối với Linux (Ubuntu / Debian):

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER
newgrp docker
```

Xác nhận Docker và Docker Compose hoạt động:

```bash
docker --version
docker compose version
```

Output mong đợi:

```
Docker version 27.x.x (hoặc mới hơn)
Docker Compose version v2.x.x
```

---

## Bước 3 — Tạo Cloudflare Zero Trust Tunnel Lấy Token

Dự án sử dụng container `iot_cloudflared` chính thức từ Cloudflare, giúp kết nối backend ra internet an toàn mà không cần mở port modem (NAT/Port Forwarding).

1. Đăng ký/Đăng nhập tài khoản Cloudflare miễn phí tại: https://dash.cloudflare.com/
2. Thêm một tên miền của bạn vào Cloudflare (hoặc sử dụng domain miễn phí).
3. Tại menu bên trái, chọn **Zero Trust** (hoặc truy cập https://one.dash.cloudflare.com/).
4. Vào mục **Networks** ➔ **Tunnels** ➔ Nhấn **Add a tunnel**.
5. Chọn loại tunnel: **Cloudflare (cloudflared)** ➔ Nhấn **Next**.
6. Đặt tên Tunnel (ví dụ: `iot-env-monitor`) ➔ Nhấn **Save tunnel**.
7. Ở mục **Choose an environment**, chọn tab **Docker**.
8. Trong ô lệnh hiển thị, bạn sẽ thấy chuỗi lệnh mẫu có dạng:
   `docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJh...`
9. **Chỉ sao chép đoạn mã token dài sau tham số `--token`** (bắt đầu bằng `eyJ...`). Đây chính là `CLOUDFLARE_TUNNEL_TOKEN`.
10. Tại tab **Public Hostname** của Tunnel đó:
    - Nhấn **Add a public hostname**.
    - Nhập **Subdomain** (ví dụ: `iot-monitor`) và chọn **Domain** của bạn.
    - Tại mục **Service**:
      - Type: **HTTP**
      - URL: `backend:3000` *(Lưu ý quan trọng: Điền đúng hostname `backend:3000` vì container cloudflared gọi sang backend trong mạng Docker nội bộ)*.
    - Nhấn **Save hostname**.

---

# PHẦN 2 — CẤU TRÚC VÀ CẤU HÌNH DỰ ÁN

## Bước 4 — Kiểm Tra Cấu Trúc Thư Mục

Cấu trúc thư mục của dự án:

```
IoT-Env-Monitor/
├── docker-compose.yml               ← Khởi chạy cụm 3 container: postgres, backend, cloudflared
├── .env.example                     ← File mẫu cấu hình biến môi trường
├── .env                             ← File cấu hình môi trường thực tế (Tự tạo, gitignored)
├── .gitignore
├── README.md
├── Struct.md                        ← Sơ đồ cấu trúc chi tiết
├── HUONG_DAN_THUC_HIEN.md           ← Tài liệu hướng dẫn này
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── DB/
│   ├── DB.sql                       ← Schema: sensor_logs (cột số thực, index) & device_credentials
│   └── auth_migration.sql           ← Schema người dùng: system_users (bcrypt), user_devices
├── BE/
│   ├── Dockerfile                   ← Build Node.js 20 Alpine (tzdata Asia/Ho_Chi_Minh, user node)
│   ├── .dockerignore                ← Loại trừ node_modules, .env khi build
│   ├── index.js                     ← Express server, API, HMAC ticket, Session store, In-memory Access Requests
│   ├── package.json                 ← Dependencies: express, pg, bcryptjs, express-session, connect-pg-simple, helmet
│   ├── package-lock.json
│   ├── login_static/
│   │   └── login.html               ← Giao diện trang đăng nhập hệ thống
│   └── admin_static/
│       ├── admin.html               ← Giao diện Web Admin Dashboard (+ Modal Tạo User, Phân quyền, Quản lý thiết bị)
│       ├── admin.css
│       └── admin.js
├── FE/                              ← Mã nguồn giao diện Web nhúng ESP32 (Nạp vào LittleFS qua data_dir = FE)
│   ├── dashboard.html
│   ├── dashboard.css
│   └── dashboard.js
├── boards/
│   └── yolo_uno.json                ← Định nghĩa board PlatformIO (ESP32-S3, flash 8MB)
├── include/                         ← Header firmware ESP32
│   ├── secrets.h.example            ← File mẫu secrets
│   ├── secrets.h                    ← Thông số bảo mật thật nạp vào ESP32 (Tự tạo, gitignored)
│   ├── dht_anomaly_model.h          ← Mô hình TinyML dạng mảng C nhúng vào Flash
│   ├── risk_label.h                 ← Định nghĩa ngưỡng Normal/Warning/Critical
│   └── global.h, pump.h, tinyml.h, task_*.h, led_blinky.h, neo_blinky.h,
│       temp_humi_monitor.h, serial_log.h, project_includes.h
├── src/                             ← Mã nguồn firmware ESP32 C++
│   ├── main.cpp, global.cpp, pump.cpp, led_blinky.cpp, neo_blinky.cpp, serial_log.cpp,
│   ├── task_check_info.cpp, task_database.cpp, task_handler.cpp, task_toogle_boot.cpp,
│   ├── task_webserver.cpp, task_wifi.cpp, temp_humi_monitor.cpp, tinyml.cpp
├── lib/                             ← Thư viện nội bộ (ArduinoJson, DHT20, LCD, ElegantOTA)
├── data/
│   └── wifi_info.json.example       ← File mẫu dữ liệu Wi-Fi
├── platformio.ini                   ← Cấu hình PlatformIO (data_dir = FE)
├── pyproject.toml
├── ml/                              ← Huấn luyện TinyML (train_export.py, dataset.csv, requirements.txt)
└── scripts/
    └── pull_wifi_info.py            ← Tool đọc trực tiếp Wi-Fi đã lưu từ Flash ESP32 qua Serial
```

---

## Bước 5 — Cấu Hình Môi Trường & Bí Mật

### 5a — File `BE/Dockerfile`

Kiểm tra nội dung file `BE/Dockerfile` đã được tối ưu bảo mật và múi giờ:

```dockerfile
FROM node:20-alpine

RUN apk add --no-cache tzdata
ENV TZ=Asia/Ho_Chi_Minh \
    NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

EXPOSE 3000

USER node

CMD ["node", "index.js"]
```

### 5b — File `BE/.dockerignore`

Kiểm tra file `BE/.dockerignore`:

```
node_modules
npm-debug.log
.env
*.md
.git
.gitignore
```

### 5c — File `.env` (Biến Môi Trường Hệ Thống)

Tại thư mục gốc `IoT-Env-Monitor/`, copy `.env.example` thành `.env`:

```powershell
# Windows PowerShell:
Copy-Item ".env.example" ".env"

# Linux / macOS:
cp .env.example .env
```

Mở file `.env` và thiết lập các thông số chính xác:

```env
# PostgreSQL (Docker + Node)
POSTGRES_PASSWORD=change-me-postgres
DB_HOST=localhost
DB_NAME=iot_db
DB_USER=iot_user
DB_PASS=change-me-db-password
DB_PORT=5433

# Express session (Chuỗi ngẫu nhiên dài dùng để ký cookie đăng nhập)
SESSION_SECRET=change-me-to-a-long-random-string

# API Key chia sẻ giữa ESP32 và Backend (Khớp SENSOR_API_KEY trong secrets.h)
SENSOR_API_KEY=password-api-key

# Tài khoản Admin khởi tạo lần đầu khi bảng system_users còn trống
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me-admin-password

# Token kết nối Cloudflare Tunnel (Lấy từ bước 3)
CLOUDFLARE_TUNNEL_TOKEN=eyJh...dien_token_cloudflare_cua_ban_vao_day...

# (Tuỳ chọn) Số ngày lưu trữ dữ liệu cảm biến (Mặc định 30, đặt 0 để không xóa)
# SENSOR_RETENTION_DAYS=30
```

**Bảng giải thích ý nghĩa các biến môi trường:**

| Biến                       | Bắt buộc | Mô tả chi tiết                                                                           |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `DB_PASS`                 | ✅         | Mật khẩu tài khoản `iot_user` dùng chung cho PostgreSQL và Backend                   |
| `DB_USER`, `DB_NAME`      | Không     | Mặc định `iot_user` và `iot_db`                                                      |
| `SESSION_SECRET`          | ✅         | Khóa bí mật ký cookie session, giữ cố định để không bị đăng xuất khi restart |
| `SENSOR_API_KEY`          | ✅         | ESP32 gửi qua header `X-Device-Key` và dùng làm khóa ký HMAC Device Ticket           |
| `ADMIN_USERNAME`          | Không     | Tên tài khoản Admin quản trị (mặc định: `admin`)                                   |
| `ADMIN_PASSWORD`          | ✅         | Mật khẩu quản trị viên (dùng khởi tạo tự động lần đầu)                        |
| `CLOUDFLARE_TUNNEL_TOKEN` | ✅         | Token xác thực của Cloudflare Zero Trust để kích hoạt ingress tunnel                 |
| `SENSOR_RETENTION_DAYS`   | Không     | Tự động xóa dữ liệu cảm biến cũ sau số ngày chỉ định (mặc định: 30)        |

---

### 5d — File `include/secrets.h` (Cấu Hình Firmware ESP32)

Tại thư mục gốc, copy `include/secrets.h.example` thành `include/secrets.h`:

```powershell
# Windows PowerShell:
Copy-Item "include\secrets.h.example" "include\secrets.h"

# Linux / macOS:
cp include/secrets.h.example include/secrets.h
```

Mở `include/secrets.h` và thiết lập:

```cpp
#pragma once

// Tên và mật khẩu Wi-Fi Access Point do ESP32 phát ra khi chưa có mạng
#ifndef SSID_AP
#define SSID_AP "ESP32 LOCAL"
#endif

#ifndef PASS_AP
#define PASS_AP "12345678" // Tối thiểu 8 ký tự theo chuẩn WPA2
#endif

// Tài khoản HTTP Basic Auth khi truy cập trực tiếp Web Dashboard của ESP32
#ifndef DEVICE_HTTP_USER
#define DEVICE_HTTP_USER "admin"
#endif

#ifndef DEVICE_HTTP_PASS
#define DEVICE_HTTP_PASS "device-password"
#endif

// BẮT BUỘC TRÙNG VỚI SENSOR_API_KEY TRONG FILE .env
#ifndef SENSOR_API_KEY
#define SENSOR_API_KEY "password-api-key"
#endif

// URL Backend (Domain Cloudflare Tunnel). Có thể ghi đè bằng file /server.json trên LittleFS
#ifndef SENSOR_API_URL
#define SENSOR_API_URL "https://iot-monitor.yourdomain.com"
#endif

// Tài khoản OTA (mặc định kế thừa từ DEVICE_HTTP_USER/PASS nếu không ghi đè)
#ifndef OTA_HTTP_USER
#define OTA_HTTP_USER DEVICE_HTTP_USER
#endif

#ifndef OTA_HTTP_PASS
#define OTA_HTTP_PASS DEVICE_HTTP_PASS
#endif
```

---

### 5e — File `docker-compose.yml`

File `docker-compose.yml` ở thư mục gốc khai báo cụm 3 container:

```yaml
services:

  # ─── PostgreSQL Database ────────────────────────────────────
  postgres:
    container_name: iot_postgres
    image: postgres:16-alpine
    restart: unless-stopped
    ports:
      # 5433 trên host (chỉ localhost) → 5432 trong container
      - "127.0.0.1:5433:5432"
    environment:
      POSTGRES_USER: ${DB_USER:-iot_user}
      POSTGRES_PASSWORD: ${DB_PASS:?Set DB_PASS in .env}
      POSTGRES_DB: ${DB_NAME:-iot_db}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./DB/DB.sql:/docker-entrypoint-initdb.d/01_schema.sql
      - ./DB/auth_migration.sql:/docker-entrypoint-initdb.d/02_auth.sql
    networks:
      - iot_net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \"$$POSTGRES_USER\" -d \"$$POSTGRES_DB\""]
      interval: 5s
      timeout: 5s
      retries: 10
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  # ─── Node.js Backend ────────────────────────────────────────
  backend:
    container_name: iot_backend
    build:
      context: ./BE
      dockerfile: Dockerfile
    restart: unless-stopped
    # Không publish cổng 3000 ra host/LAN — chỉ cloudflared truy cập nội bộ
    expose:
      - "3000"
    env_file:
      - .env
    environment:
      DB_HOST: postgres
      DB_NAME: ${DB_NAME:-iot_db}
      DB_USER: ${DB_USER:-iot_user}
      DB_PASS: ${DB_PASS:?Set DB_PASS in .env}
      DB_PORT: "5432"
      SESSION_SECRET: ${SESSION_SECRET:?Set SESSION_SECRET in .env}
      SENSOR_API_KEY: ${SENSOR_API_KEY:?Set SENSOR_API_KEY in .env}
      ADMIN_USERNAME: ${ADMIN_USERNAME:-admin}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:?Set ADMIN_PASSWORD in .env}
      TRUST_PROXY: "1"
    depends_on:
      postgres:
        condition: service_healthy
    networks:
      - iot_net
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:3000/api/me',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  # ─── Cloudflare Tunnel ──────────────────────────────────────
  cloudflared:
    container_name: iot_cloudflared
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN:?Set CLOUDFLARE_TUNNEL_TOKEN in .env}
    depends_on:
      backend:
        condition: service_healthy
    networks:
      - iot_net
    logging:
      driver: json-file
      options:
        max-size: "5m"
        max-file: "2"

networks:
  iot_net:
    driver: bridge

volumes:
  pgdata:
    driver: local
```

> [!NOTE]
> Nếu bạn muốn truy cập trực tiếp Backend từ máy host để kiểm thử qua `http://localhost:3000`, chỉ cần tạm thời thay thế `expose: - "3000"` thành `ports: - "3000:3000"` trong service `backend`.

---

# PHẦN 3 — BUILD VÀ KHỞI ĐỘNG

## Bước 6 — Mở Terminal Tại Thư Mục Gốc

Di chuyển vào thư mục dự án chứa file `docker-compose.yml`:

```bash
cd /path/to/IoT-Env-Monitor
```

## Bước 7 — Khởi Động Toàn Bộ Stack Bằng Docker Compose

Chạy lệnh build image và kích hoạt cụm 3 container ở chế độ chạy nền (`-d`):

```bash
docker compose up -d --build
```

Trình tự tự động diễn ra:

1. Docker build image `iot_backend` từ thư mục `BE/` (cài tzdata, chạy dưới user `node`).
2. Tải image `postgres:16-alpine` và `cloudflare/cloudflared:latest`.
3. Tạo volume `pgdata` và bridge network `iot_net`.
4. Chạy `iot_postgres`, tự động thực thi `01_schema.sql` và `02_auth.sql`.
5. Sau khi PostgreSQL đạt trạng thái `healthy`, `iot_backend` khởi chạy, tự động chạy `ensureSchema()`, seed tài khoản admin ban đầu và kiểm tra dọn dẹp log định kỳ.
6. Sau khi Backend đạt trạng thái `healthy`, container `iot_cloudflared` kết nối tới Cloudflare Edge Network.

---

## Bước 8 — Xác Nhận Trạng Thái Các Container

Kiểm tra danh sách container:

```bash
docker compose ps
```

Output mong đợi:

```
NAME              IMAGE                          COMMAND                  STATUS                   PORTS
iot_backend       iot-env-monitor-backend        "docker-entrypoint.s…"   Up (healthy)             3000/tcp
iot_cloudflared   cloudflare/cloudflared:latest  "cloudflared --no-au…"   Up                     
iot_postgres      postgres:16-alpine             "docker-entrypoint.s…"   Up (healthy)             127.0.0.1:5433->5432/tcp
```

Xem log kiểm tra backend:

```bash
docker compose logs backend
```

Output mong đợi:

```
API running on port 3000
Seeded admin user "admin".
```

Xem log kiểm tra kết nối Cloudflare Tunnel:

```bash
docker compose logs cloudflared
```

Output mong đợi:

```
Registered tunnel connection ...
Connection ... registered
```

---

# PHẦN 4 — KIỂM TRA HỆ THỐNG

## Bước 9 — Kiểm Tra Giao Diện Web Backend

Mở trình duyệt và truy cập vào tên miền Public Hostname đã cấu hình trên Cloudflare Tunnel (hoặc `http://localhost:3000` nếu bạn đã publish cổng 3000):

```
https://iot-monitor.yourdomain.com
```

- Hệ thống tự động chuyển hướng đến `/login`.
- Đăng nhập bằng `ADMIN_USERNAME` và `ADMIN_PASSWORD` đã cấu hình trong `.env`.
- Sau khi đăng nhập, giao diện **Admin Dashboard** (`/admin/admin.html`) hiển thị đầy đủ thanh công cụ, các nút **➕ Tạo User**, **👥 Phân quyền**, **Làm mới**, **Đăng xuất**.

---

## Bước 10 — Kiểm Tra Kết Nối PostgreSQL Trong Container

Kết nối trực tiếp vào PostgreSQL bằng công cụ `psql` bên trong container:

```bash
docker exec -it iot_postgres psql -U iot_user -d iot_db
```

Kiểm tra danh sách bảng đã khởi tạo:

```sql
\dt
```

Output phải bao gồm **5 bảng**:

```
              List of relations
 Schema |        Name        | Type  |  Owner   
--------+--------------------+-------+----------
 public | device_credentials | table | iot_user
 public | sensor_logs        | table | iot_user
 public | session            | table | iot_user
 public | system_users       | table | iot_user
 public | user_devices       | table | iot_user
(5 rows)
```

Kiểm tra kiểu dữ liệu các cột đo cảm biến (phải là `double precision`):

```sql
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'sensor_logs' 
  AND column_name IN ('temperature', 'humidity', 'soil_moisture', 'lan_ip', 'received_at');
```

Thoát psql:

```sql
\q
```

---

## Bước 11 — Quản Lý Database Bằng pgAdmin (Tuỳ Chọn)

Kết nối qua phần mềm pgAdmin cài đặt trên máy host:

- **Host**: `127.0.0.1` hoặc `localhost`
- **Port**: `5433` (Cổng đã ánh xạ an toàn trên host)
- **Database**: `iot_db`
- **Username**: `iot_user`
- **Password**: Giá trị `DB_PASS` trong file `.env`

---

# PHẦN 5 — CẤU HÌNH VÀ NẠP CODE CHO ESP32

## Bước 12 — Cập Nhật URL Server Cho ESP32

Bạn có hai cách để cấu hình URL nhận dữ liệu cho ESP32:

### Cách 1: Cấu hình qua Web Dashboard của ESP32 (Không cần nạp lại firmware — Khuyên dùng)

1. ESP32 khi chưa có Wi-Fi hoặc sau khi nạp LittleFS sẽ tự động phát Wi-Fi AP tên `ESP32 LOCAL` (Mật khẩu: `PASS_AP` trong `secrets.h`, ví dụ: `12345678`).
2. Kết nối máy tính hoặc điện thoại vào Wi-Fi `ESP32 LOCAL` và truy cập: `http://192.168.4.1/`.
3. Nhập tài khoản Basic Auth (`DEVICE_HTTP_USER` / `DEVICE_HTTP_PASS`, mặc định `admin` / `device-password`).
4. Bấm biểu tượng bánh răng **Settings** trên thanh điều hướng:
   - Nhập tên SSID và mật khẩu Wi-Fi nhà bạn.
   - Tại ô **URL backend (HTTPS ổn định)**, dán URL Cloudflare Tunnel của bạn: `https://iot-monitor.yourdomain.com`.
   - Nhấn nút **Lưu & Kết nối**: ESP32 sẽ đồng thời lưu thông tin Wi-Fi vào `/info.dat`, `/wifi_list.json` và lưu URL server vào `/server.json`, sau đó tự khởi động lại để kết nối vào mạng Wi-Fi nhà bạn.

### Cách 2: Cập nhật tĩnh trong `include/secrets.h`

Mở file `include/secrets.h`, gán trực tiếp:

```cpp
#ifndef SENSOR_API_URL
#define SENSOR_API_URL "https://iot-monitor.yourdomain.com"
#endif
```

Sau đó biên dịch và nạp lại firmware ở Bước 14.

---

## Bước 13 — Chuẩn Bị Môi Trường PlatformIO

1. Mở thư mục dự án `IoT-Env-Monitor` trong **VS Code**.
2. Đảm bảo đã cài extension **PlatformIO IDE** và **Git** trên máy host.
3. Kiểm tra file `platformio.ini`:

```ini
[platformio]
data_dir = FE

[env:yolo_uno]
platform = espressif32
board = yolo_uno
framework = arduino
monitor_speed = 115200
board_build.filesystem = littlefs
upload_port = /dev/ttyACM0      ; Nếu trên Windows, đổi thành cổng COM tương ứng (ví dụ COM7)
monitor_port = /dev/ttyACM0

build_flags =
    -D CORE_DEBUG_LEVEL=0
    -D ARDUINO_USB_MODE=1
    -D ARDUINO_USB_CDC_ON_BOOT=1
    -DELEGANTOTA_USE_ASYNC_WEBSERVER=1

lib_deps = 
    tanakamasayuki/TensorFlowLite_ESP32@1.0.0
    adafruit/Adafruit NeoPixel@^1.15.1
    https://github.com/me-no-dev/ESPAsyncWebServer.git

lib_compat_mode = strict
```

> [!TIP]
> Trên Windows, mở **Device Manager** xem mục *Ports (COM & LPT)* để biết chính xác cổng COM của board YOLO UNO (ESP32-S3).

---

## Bước 14 — Biên Dịch, Nạp Firmware & Nạp LittleFS

Cắm board ESP32-S3 qua cổng USB vào máy tính.

### 1. Nạp Firmware C++:

Chạy qua terminal PlatformIO:

```powershell
pio run --target upload
```

*(Hoặc bấm nút mũi tên Upload ở thanh trạng thái dưới cùng của VS Code).*

### 2. Nạp Filesystem LittleFS (Giao diện nhúng):

Thư mục `FE/` chứa toàn bộ giao diện Web Dashboard nhúng của thiết bị:

```powershell
pio run --target uploadfs
```

*(Hoặc vào menu PlatformIO ➔ yolo_uno ➔ Platform ➔ Upload Filesystem Image).*

> [!CAUTION]
> Lệnh `uploadfs` sẽ ghi đè toàn bộ phân vùng LittleFS, xóa các file cấu hình lưu tạm (`/info.dat`, `/wifi_list.json`, `/server.json`). Sau khi chạy `uploadfs`, ESP32 sẽ phát lại Wi-Fi AP và bạn cần cấu hình lại theo Bước 12.

### 3. Đặt lại cấu hình Wi-Fi bằng nút cứng BOOT:

Khi cần reset Wi-Fi mà không cần nạp lại code, nhấn giữ nút **BOOT** (GPIO0) trên board liên tục trên **2 giây**. ESP32 sẽ xóa cấu hình mạng (`/info.dat`, `/wifi_list.json`, `/wifi_info.json`) và tự khởi động lại về chế độ phát Wi-Fi AP. File cấu hình `/server.json` được bảo lưu nguyên vẹn.

---

## Bước 15 — Xác Nhận Dữ Liệu Gửi Thành Công

Mở Serial Monitor để theo dõi log hoạt động của ESP32:

```powershell
pio device monitor -b 115200
```

Output mong đợi (chu kỳ 5 giây):

```
TinyML T=26.5°C H=68.2% S=36% | rule=1 pred=1 | Normal | p=[0.98,0.02,0.00] | 1ms | roll_acc=100.0% (15/15)
[DB] POST thành công -> 200 (còn 0)
```

- Nhìn thấy dòng `[DB] POST thành công -> 200` biểu thị ESP32 đã gửi telemetry thành công qua Cloudflare Tunnel lên backend.
- Mở trang Admin Dashboard (`https://iot-monitor.yourdomain.com`), thiết bị sẽ xuất hiện thẻ trạng thái **Online** (địa chỉ MAC làm Device ID), hiển thị các chỉ số Nhiệt độ, Độ ẩm KK, Độ ẩm đất và IP mạng nội bộ (`lan_ip`).
- Nếu cảm biến DHT20 bị rút hoặc mất kết nối, hệ thống sẽ hiển thị giá trị an toàn `T:--.-C H:--.-%` trên LCD và gửi chuỗi `"--"` lên backend mà không gây crash hệ thống.

---

# PHẦN 6 — QUẢN LÝ NGƯỜI DÙNG VÀ PHÂN QUYỀN

## Bảng Phân Quyền Theo Vai Trò

| Tính năng                                          |     Admin     |                  User                  |
| ---------------------------------------------------- | :-----------: | :-------------------------------------: |
| Xem danh sách tất cả thiết bị                   |      ✅      |  ❌ (Chỉ xem thiết bị được gán)  |
| Xóa dữ liệu cảm biến thiết bị                 |      ✅      |                   ❌                   |
| Đặt / Thay đổi / Xóa mật khẩu thiết bị      |      ✅      |                   ❌                   |
| Tạo tài khoản User mới                           | ✅ (Trên UI) |                   ❌                   |
| Phân quyền gán thiết bị cho User                | ✅ (Trên UI) |                   ❌                   |
| Duyệt yêu cầu truy cập thiết bị chưa có pass |      ✅      |                   ❌                   |
| Vào trực tiếp Dashboard của mọi thiết bị      |      ✅      | ❌ (Cần mật khẩu hoặc Admin duyệt) |

---

## Bước 16 — Tạo Tài Khoản User Trên Giao Diện Admin

1. Đăng nhập trang Admin bằng tài khoản quản trị.
2. Trên thanh Header, nhấn nút **➕ Tạo User**.
3. Nhập **Tên đăng nhập** và **Mật khẩu** (tối thiểu 6 ký tự).
4. Nhấn **Tạo tài khoản**. Thông báo `✓ Đã tạo tài khoản "<username>"` xuất hiện.

---

## Bước 17 — Phân Quyền Thiết Bị Cho User

1. Trên thanh Header của trang Admin, nhấn **👥 Phân quyền**.
2. Chọn tài khoản cần gán tại mục **Tài khoản (User)**.
3. Tích chọn các thiết bị cho phép người dùng này quản lý và theo dõi.
4. Nhấn **Lưu phân quyền**.
5. Khi User đăng nhập tài khoản của họ, họ sẽ chỉ thấy các thiết bị đã được tích chọn. Nếu chưa được gán thiết bị nào, danh sách hiển thị trống.

---

## Bước 18 — Quản Lý Mật Khẩu Thiết Bị & Xác Thực Truy Cập

Trên mỗi thẻ thiết bị ở trang Admin có nút biểu tượng mũi tên chuyển hướng sang Web Dashboard cục bộ (`http://<lan_ip>/`):

### 18a — Đối với Admin:

- Khi nhấn mũi tên, mở hộp thoại **⚙ Quản lý thiết bị**:
  - Bấm **Vào Dashboard**: Truy cập trực tiếp Dashboard thiết bị không bị chặn.
  - Bấm **Lưu mật khẩu**: Đặt hoặc đổi mật khẩu riêng cho thiết bị (mã hóa bcrypt lưu tại bảng `device_credentials`).
  - Bấm **Xóa mật khẩu thiết bị**: Xóa mật khẩu bảo vệ để đưa về trạng thái mở cho user xin cấp quyền.

### 18b — Đối với User (Thiết bị đã có mật khẩu):

- Hộp thoại **🔐 Xác thực thiết bị** hiện lên yêu cầu nhập mật khẩu thiết bị.
- Backend gọi API `/admin/api/devices/:device_id/ticket` xác thực bcrypt. Nếu đúng, backend tạo **HMAC Device Ticket** kèm thời hạn 5 phút.
- Trình duyệt tự động chuyển hướng đến Dashboard ESP32 kèm token:
  `http://<lan_ip>/?ticket=<hmac_token>`

### 18c — Đối với User (Thiết bị chưa có mật khẩu — Duyệt Realtime):

1. User nhấn **Đăng nhập** trên hộp thoại. Hệ thống phát hiện thiết bị chưa có mật khẩu và chuyển sang trạng thái: `Đang gửi yêu cầu đến Admin...`.
2. Trên màn hình của Admin (đang mở trang Admin Dashboard), xuất hiện thanh thông báo nổi:
   `🔔 <username> xin truy cập thiết bị <device_id>` kèm nút **✓ Chấp nhận** và **✕ Từ chối**.
3. Admin bấm **Chấp nhận**:
   - Màn hình User nhận phản hồi trong vòng 2 giây: `Admin đã chấp nhận! Đang chuyển hướng...`.
   - User được chuyển hướng thẳng vào Dashboard của thiết bị (`http://<lan_ip>/`).
4. Nếu Admin bấm **Từ chối**: Hộp thoại báo `Admin đã từ chối yêu cầu truy cập.`

---

# PHẦN 7 — QUẢN LÝ CONTAINER HÀNG NGÀY

## Khởi Động Hàng Ngày

```bash
docker compose up -d
```

## Dừng Toàn Bộ Hệ Thống

```bash
docker compose stop
```

## Xem Log Thời Gian Thực

```bash
# Xem toàn bộ 3 container
docker compose logs -f

# Xem riêng backend
docker compose logs -f backend

# Xem riêng Cloudflare tunnel
docker compose logs -f cloudflared
```

## Rebuild Khi Cập Nhật Code Backend

Khi bạn sửa đổi code trong thư mục `BE/` (`Dockerfile`, `index.js`, `admin.js`, `admin.html`...):

```bash
docker compose up -d --build backend
```

## Nạp Lại Giao Diện Hoặc Firmware ESP32

```powershell
# Khi sửa file giao diện trong FE/
pio run --target uploadfs

# Khi sửa mã nguồn C++ trong src/ hoặc include/
pio run --target upload
```

## Đọc Danh Sách Wi-Fi Đã Lưu Bằng Python Tool

Script `scripts/pull_wifi_info.py` hỗ trợ trích xuất toàn bộ danh sách Wi-Fi đã lưu trong Flash của ESP32 ra file `data/wifi_info.json`:

1. Cài đặt thư viện:
   ```bash
   pip install esptool littlefs-python
   ```
2. Đóng Serial Monitor rồi chạy lệnh:
   ```bash
   # Trên Linux:
   python scripts/pull_wifi_info.py --port /dev/ttyACM0

   # Trên Windows:
   python scripts\pull_wifi_info.py --port COM7
   ```

## Huấn Luyện Lại Mô Hình TinyML

Nếu bạn thay đổi công thức hoặc trọng số đánh giá rủi ro trong `include/risk_label.h`:

```bash
pip install -r ml/requirements.txt
python ml/train_export.py
```

Script sẽ sinh lại file mô hình nhúng `include/dht_anomaly_model.h`. Sau đó chỉ cần nạp lại firmware (`pio run --target upload`).

---

# PHẦN 8 — XỬ LÝ SỰ CỐ (TROUBLESHOOTING)

### 1. Backend Báo Lỗi `password authentication failed for user "iot_user"`

- **Nguyên nhân**: Mật khẩu `DB_PASS` trong `.env` bị thay đổi khác so với lúc volume `pgdata` được tạo lần đầu.
- **Khắc phục**: Sửa lại đúng mật khẩu cũ trong `.env`. Nếu muốn xóa tạo lại từ đầu, chạy: `docker compose down -v` rồi `docker compose up -d --build`.

### 2. Lỗi `Set CLOUDFLARE_TUNNEL_TOKEN in .env`

- **Nguyên nhân**: Chưa khai báo biến `CLOUDFLARE_TUNNEL_TOKEN` trong `.env`.
- **Khắc phục**: Làm theo Bước 3 để lấy token từ Cloudflare Zero Trust và dán vào `.env`.

### 3. Đăng Nhập Báo `429 — Quá nhiều lần thử`

- **Nguyên nhân**: Nhập sai mật khẩu liên tiếp quá 5 lần trong vòng 15 phút.
- **Khắc phục**: Reset bộ nhớ rate-limit bằng lệnh:
  ```bash
  docker compose restart backend
  ```
- **Lưu ý**: Cấu hình `TRUST_PROXY: "1"` trong `docker-compose.yml` đảm bảo mỗi client truy cập qua Cloudflare có địa chỉ IP riêng biệt, không bị gộp chung làm nghẽn rate-limit.

### 4. ESP32 Gửi Dữ Liệu Báo `[DB] POST thất bại: 401`

- **Nguyên nhân**: Giá trị `SENSOR_API_KEY` trong file `include/secrets.h` không khớp với giá trị `SENSOR_API_KEY` trong file `.env`.
- **Khắc phục**: Đồng bộ lại cùng một chuỗi bí mật ở cả 2 file, sau đó nạp lại firmware cho ESP32 và khởi động lại backend.

### 5. Thiết Bị Báo Online Nhưng Lệch Thời Gian Hoặc Không Nhận Realtime

- **Nguyên nhân**: Giờ của ESP32 chưa được đồng bộ qua NTP hoặc lệch múi giờ.
- **Khắc phục**: Firmware tự động đồng bộ NTP khi có Wi-Fi (`pool.ntp.org`, múi giờ GMT+7). Đảm bảo mạng Wi-Fi của ESP32 có kết nối internet.

### 6. Lỗi `uploadfs` Báo Không Tìm Thấy Thư Mục Dữ Liệu

- **Nguyên nhân**: File `platformio.ini` chưa có chỉ thị `data_dir = FE`.
- **Khắc phục**: Đảm bảo dòng `data_dir = FE` nằm trong khối `[platformio]` ở đầu file `platformio.ini`.

---

# PHẦN 9 — THÔNG TIN THAM KHẢO TOÀN DIỆN

## Bảng Thông Tin Kết Nối Mạng

| Thành phần              | Địa chỉ truy cập             | Ghi chú                                                   |
| ------------------------- | -------------------------------- | ---------------------------------------------------------- |
| Web Admin / API (Public)  | `https://<subdomain>.domain`   | Truy cập an toàn qua Cloudflare Tunnel                   |
| Web Backend (Local host)  | `http://localhost:3000`        | Khi cấu hình mở cổng trong `docker-compose.yml`       |
| PostgreSQL DB (Host)      | `127.0.0.1:5433`               | Cổng dành riêng cho máy host quản trị (pgAdmin/psql) |
| PostgreSQL DB (Nội bộ)  | `postgres:5432`                | Giao tiếp nội bộ giữa các container trong `iot_net`  |
| Web Dashboard ESP32 (LAN) | `http://<lan_ip_esp32>/`       | Truy cập trực tiếp trong mạng Wi-Fi nội bộ           |
| Web Dashboard ESP32 (AP)  | `http://192.168.4.1/`          | Khi kết nối vào Wi-Fi AP `ESP32 LOCAL`                 |
| ElegantOTA ESP32          | `http://<lan_ip_esp32>/update` | Nạp firmware qua mạng Wi-Fi                              |

---

## Chi Tiết Các Bảng Database PostgreSQL

| Tên bảng             | Tạo bởi                       | Chức năng chính                                               |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------- |
| `sensor_logs`        | `DB.sql` + `ensureSchema()` | Lưu trữ dữ liệu cảm biến định kỳ và sự kiện bơm     |
| `device_credentials` | `DB.sql`                      | Lưu trữ mật khẩu thiết bị (mã hóa bcrypt)                |
| `system_users`       | `auth_migration.sql`          | Tài khoản đăng nhập hệ thống Admin và User (bcrypt)      |
| `user_devices`       | `auth_migration.sql`          | Bảng quan hệ phân quyền: user nào quản lý thiết bị nào |
| `session`            | Backend (`connect-pg-simple`) | Quản lý phiên làm việc, chống mất đăng nhập            |

---

## Danh Mục API Backend

| Phương thức | Đường dẫn                               | Quyền           | Chức năng                                             |
| -------------- | ------------------------------------------- | ---------------- | ------------------------------------------------------- |
| `POST`       | `/sensor`                                 | `X-Device-Key` | Nhận dữ liệu telemetry từ ESP32                     |
| `POST`       | `/login`                                  | Rate Limit       | Đăng nhập tài khoản hệ thống                     |
| `POST`       | `/logout`                                 | Session          | Đăng xuất phiên làm việc                          |
| `GET`        | `/api/me`                                 | Public           | Kiểm tra thông tin phiên / Healthcheck backend       |
| `GET`        | `/admin/api/devices`                      | User/Admin       | Lấy danh sách thiết bị kèm trạng thái mới nhất |
| `GET`        | `/admin/api/devices/:id/history`          | User/Admin       | Lấy lịch sử cảm biến theo thiết bị               |
| `DELETE`     | `/admin/api/devices/:id`                  | Admin            | Xóa toàn bộ dữ liệu lịch sử của thiết bị (hỗ trợ `lan_ip`) |
| `POST`       | `/admin/api/devices/:id/ticket`           | User/Admin       | Xác thực mật khẩu và cấp HMAC Device Ticket       |
| `POST`       | `/admin/api/devices/:id/access-request`   | User             | Gửi yêu cầu xin truy cập thiết bị chưa có pass  |
| `GET`        | `/admin/api/access-requests`              | Admin            | Xem danh sách yêu cầu truy cập đang chờ duyệt    |
| `POST`       | `/admin/api/access-requests/:id/decision` | Admin            | Duyệt chấp nhận hoặc từ chối yêu cầu truy cập  |
| `GET`        | `/admin/api/access-requests/:id/status`   | User             | Kiểm tra trạng thái yêu cầu truy cập đang chờ duyệt |
| `POST`       | `/admin/api/devices/:id/password`         | Admin            | Đặt hoặc thay đổi mật khẩu thiết bị            |
| `DELETE`     | `/admin/api/devices/:id/password`         | Admin            | Xóa mật khẩu thiết bị                              |
| `GET`        | `/admin/api/users`                        | Admin            | Lấy danh sách người dùng hệ thống                |
| `POST`       | `/admin/api/users`                        | Admin            | Tạo tài khoản người dùng mới                     |
| `DELETE`     | `/admin/api/users/:id`                    | Admin            | Xóa tài khoản người dùng                          |
| `GET`        | `/admin/api/users/:id/devices`            | Admin            | Xem danh sách thiết bị được gán cho user         |
| `PUT`        | `/admin/api/users/:id/devices`            | Admin            | Cập nhật danh sách thiết bị gán cho user          |

---

## Danh Mục API Trên ESP32 Webserver (Cổng 80)

| Phương thức     | Đường dẫn                   | Xác thực           | Chức năng                                                |
| ------------------ | ------------------------------- | -------------------- | ---------------------------------------------------------- |
| `GET`            | `/` hoặc `/dashboard.html` | Basic Auth / AP Mode | Phục vụ trang Dashboard từ LittleFS                     |
| `GET`            | `/api/status`                 | Basic Auth           | Trả trạng thái kết nối và cờ chế độ AP           |
| `GET`            | `/api/ws-token`               | Basic Auth           | Cấp token ngẫu nhiên 32 ký tự hex (30s) xác thực WS |
| `GET`            | `/toggle-pump`                | Basic Auth           | Bật / Tắt bơm và chuyển sang chế độ MANUAL         |
| `GET`            | `/set-mode`                   | Basic Auth           | Chuyển đổi giữa chế độ bơm AUTO và MANUAL         |
| `GET`            | `/api/wifi-list`              | Basic Auth           | Lấy danh sách các mạng Wi-Fi đã lưu trong Flash     |
| `POST`           | `/api/wifi-switch`            | Basic Auth           | Chuyển đổi kết nối sang SSID khác                    |
| `GET` / `POST` | `/api/server-url`             | Basic Auth           | Đọc / Cập nhật URL backend ghi vào `/server.json`    |
| `WS`             | `/ws`                         | WS Token             | Kênh WebSocket truyền nhận telemetry và điều khiển  |
| `GET`            | `/update`                     | Basic Auth (OTA)     | Giao diện nạp firmware không dây ElegantOTA            |

---

## Chi Tiết Phần Cứng & Ngưỡng Hoạt Động ESP32-S3

**Sơ đồ chân kết nối phần cứng:**

- **Cảm biến DHT20**: Giao tiếp I2C — SDA nối `GPIO 11`, SCL nối `GPIO 12`
- **Màn hình LCD 16x2**: Giao tiếp I2C cùng bus — Địa chỉ `0x27`
- **Cảm biến độ ẩm đất**: Ngõ ra Analog nối chân ADC `GPIO 2`
- **Máy bơm mini (qua Relay)**: Chân điều khiển nối `GPIO 10`
- **Đèn LED báo nhiệt độ**: Chân tín hiệu nối `GPIO 48`
- **Đèn NeoPixel RGB báo độ ẩm KK**: Chân dữ liệu nối `GPIO 45`
- **Nút bấm BOOT**: Nối chân `GPIO 0` (Nhấn giữ > 2 giây để reset Wi-Fi)

**Bảng ngưỡng phân loại rủi ro (`risk_label.h`):**

| Thông số                         | Mức Normal (Bình thường) | Mức Warning (Cảnh báo)         | Mức Critical (Nguy hiểm) |
| ---------------------------------- | ---------------------------- | --------------------------------- | -------------------------- |
| **Nhiệt độ (°C)**        | 15.0 – 25.0                 | 10.0 – <15.0 hoặc >25.0 – 30.0 | <10.0 hoặc >30.0          |
| **Độ ẩm không khí (%)** | 60.0 – 70.0                 | 50.0 – <60.0 hoặc >70.0 – 80.0 | <50.0 hoặc >80.0          |
| **Độ ẩm đất (%)**       | 30.0 – 40.0                 | 25.0 – <30.0 hoặc >40.0 – 45.0 | <25.0 hoặc >45.0          |

**Quy tắc điều khiển phần cứng:**

- **LED đơn (`GPIO 48`)**: Nhấp nháy theo mức rủi ro nhiệt độ — Normal (chu kỳ 1000ms), Warning (chu kỳ 500ms), Critical (chu kỳ 100ms).
- **NeoPixel RGB (`GPIO 45`)**: Đổi màu theo độ ẩm không khí — Normal (Màu xanh lá), Warning (Màu vàng), Critical (Màu đỏ). Cập nhật theo sự kiện khi đổi trạng thái.
- **Máy bơm (`GPIO 10`)**:
  - Tự động bật khi độ ẩm đất rơi xuống dưới **25%**, tự động ngắt khi độ ẩm đạt ngưỡng **32%**.
  - Thời gian tưới liên tục tối đa trong một lượt: **60 giây**, sau đó bắt buộc nghỉ giãn cách **120 giây** (cooldown).
  - Tự động khóa bơm (`auto_fault`) và cảnh báo nếu sau 3 lần tưới liên tiếp mà độ ẩm đất không tăng thêm được ít nhất **3%**.
  - Chế độ điều khiển tay (MANUAL) tự động ngắt sau **5 phút** để đảm bảo an toàn tuyệt đối chống tràn.

---

# TÓM TẮT THỨ TỰ TRIỂN KHAI HỆ THỐNG

```
Bước 1  → Cài đặt WSL2 (wsl --install) & Khởi động lại Windows
Bước 2  → Cài đặt Docker Desktop (bật WSL2 engine) hoặc Docker Engine trên Linux
Bước 3  → Tạo Cloudflare Tunnel trên Zero Trust Dashboard, lấy Token và cấu hình Ingress Hostname trỏ về http://backend:3000
Bước 4  → Mở dự án IoT-Env-Monitor, kiểm tra đầy đủ các thư mục theo Struct.md
Bước 5  → Thiết lập biến môi trường và file bí mật:
          - Copy .env.example sang .env: Điền DB_PASS, SESSION_SECRET, SENSOR_API_KEY, ADMIN_PASSWORD, CLOUDFLARE_TUNNEL_TOKEN
          - Copy include/secrets.h.example sang include/secrets.h: Điền SENSOR_API_KEY trùng khớp, SENSOR_API_URL là Cloudflare Domain
Bước 6  → Mở Terminal tại thư mục gốc dự án
Bước 7  → Khởi động cụm 3 container Docker: docker compose up -d --build
Bước 8  → Kiểm tra container sẵn sàng: docker compose ps (Cả 3 container iot_postgres, iot_backend, iot_cloudflared đều Up)
Bước 9  → Mở trình duyệt vào Cloudflare Domain: Đăng nhập giao diện Admin Dashboard
Bước 10 → (Tuỳ chọn) docker exec -it iot_postgres psql -U iot_user -d iot_db để kiểm tra các bảng
Bước 11 → Cấu hình platformio.ini: upload_port, monitor_port phù hợp với cổng kết nối ESP32
Bước 12 → Nạp firmware cho ESP32-S3 qua PlatformIO: pio run --target upload
Bước 13 → Nạp giao diện Web nhúng vào LittleFS: pio run --target uploadfs
Bước 14 → Kết nối Wi-Fi "ESP32 LOCAL" (192.168.4.1), vào Settings cấu hình Wi-Fi nhà và URL Cloudflare Tunnel -> Bấm "Lưu & Kết nối"
Bước 15 → Mở Serial Monitor 115200 baud xác nhận: "[DB] POST thành công -> 200"
Bước 16 → Quay lại trang Web Admin Dashboard: Thấy thiết bị Online hiển thị chỉ số thời gian thực
Bước 17 → Tạo tài khoản User mới bằng nút "➕ Tạo User"
Bước 18 → Gán thiết bị cho User qua nút "👥 Phân quyền"
Bước 19 → Trải nghiệm tính năng đăng nhập thiết bị qua HMAC Device Ticket hoặc duyệt yêu cầu truy cập in-memory realtime!
```
