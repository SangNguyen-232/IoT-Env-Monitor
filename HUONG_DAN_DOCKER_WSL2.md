# Hướng Dẫn Triển Khai IoT System — Docker + WSL2

## Kiến Trúc Tổng Quan

```
┌─────────────────────────────────────── Windows Host ──────────────────────────┐
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                    Docker Desktop (WSL2 backend)                        │  │
│  │                                                                         │  │
│  │  ┌───────────────────────────────────────────────────────────────────┐  │  │
│  │  │              docker-compose network: iot_net (bridge)             │  │  │
│  │  │                                                                   │  │  │
│  │  │  ┌──────────────────────────┐    ┌─────────────────────────────┐  │  │  │
│  │  │  │  container: iot_backend  │    │  container: iot_postgres    │  │  │  │
│  │  │  │  Image: node:20-alpine   │◄──►│  Image: postgres:16-alpine  │  │  │  │
│  │  │  │  Port: 3000 → 3000       │    │  Port: 5433 → 5432          │  │  │  │
│  │  │  │  Node.js / Express       │    │  DB: iot_db                 │  │  │  │
│  │  │  │  DB_HOST: postgres       │    │  User: postgres / iot_user  │  │  │  │
│  │  │  └──────────────────────────┘    └─────────────────────────────┘  │  │  │
│  │  │                                        Volume: pgdata             │  │  │
│  │  └───────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                         │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                │ localhost:3000                          │ localhost:5433     │
│                ▼                                         ▼                    │
│  ┌─────────────────────────────────┐         ┌─────────────────────────────┐  │
│  │  cloudflared tunnel             │         │  pgAdmin / psql (tuỳ chọn)  │  │
│  │  https://xxx.trycloudflare.com  │         │  kết nối: localhost:5433    │  │
│  └─────────────────────────────────┘         └─────────────────────────────┘  │
│                                                                               │
│  PlatformIO (VS Code) — build/flash firmware ESP32, đọc Serial COM port       │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS POST /sensor  (qua cloudflared tunnel)
                              ▼
                  ESP32 (bất kỳ WiFi nào)
```

**Đặc điểm kiến trúc:**

- PostgreSQL và Node.js hoàn toàn **cách ly trong Docker container** — không cần cài trực tiếp trên Windows
- Hai container giao tiếp nội bộ qua Docker network `iot_net` — backend dùng hostname `postgres` để kết nối DB
- PostgreSQL expose port `5433` ra Windows host (tránh xung đột nếu Windows đã có PostgreSQL cài sẵn trên port 5432)
- Backend expose port `3000` ra Windows host
- Dữ liệu PostgreSQL lưu trong Docker volume `pgdata` — không mất khi restart container
- ESP32 gửi dữ liệu lên Backend qua `HTTPS POST /sensor` thông qua cloudflared tunnel
- PlatformIO và COM port chạy **native trên Windows** — không bị hạn chế bởi Linux container

---

## Yêu Cầu Phần Mềm

| Phần mềm           | Phiên bản     | Ghi chú                                           |
| -------------------- | --------------- | -------------------------------------------------- |
| Windows 10/11        | 21H2 trở lên  | Cần hỗ trợ WSL2                                 |
| WSL2                 | Tích hợp sẵn | Backend engine cho Docker Desktop                  |
| Docker Desktop       | 4.x trở lên   | Cài trên Windows, dùng WSL2 backend             |
| VS Code + PlatformIO | Mới nhất      | Build/Flash firmware ESP32, đọc COM              |
| cloudflared          | Mới nhất      | Tạo public HTTPS tunnel (cài trên Windows host) |

---

# PHẦN 1 — CÀI ĐẶT MÔI TRƯỜNG

## Bước 1 — Cài WSL2

Mở **PowerShell với quyền Administrator** và chạy:

```powershell
wsl --install
```

Lệnh này tự động:

- Bật tính năng WSL và Virtual Machine Platform
- Tải và cài Ubuntu mặc định
- Thiết lập WSL2 làm phiên bản mặc định

**Sau khi cài xong → khởi động lại Windows.**

Sau khi restart, Ubuntu sẽ tự mở và yêu cầu tạo username/password Linux (đặt tùy ý, không liên quan đến Windows).

Xác nhận WSL2 hoạt động:

```powershell
wsl --list --verbose
```

Output mong đợi:

```
  NAME      STATE           VERSION
* Ubuntu    Running         2
```

> Cột `VERSION` phải là `2`. Nếu là `1`, chạy: `wsl --set-version Ubuntu 2`

---

## Bước 2 — Cài Docker Desktop

Tải installer tại: https://www.docker.com/products/docker-desktop/

→ Chọn **"Download for Windows — AMD64"**

Cài đặt với cấu hình:

- ✅ **Use WSL 2 instead of Hyper-V** (phải chọn)
- ✅ **Add shortcut to desktop** (tùy chọn)

Sau khi cài xong → **khởi động lại Windows**.

Sau khi restart, mở Docker Desktop → đợi đến khi hiển thị **"Engine running"** (biểu tượng Docker xanh lá trong system tray).

Xác nhận Docker hoạt động:

```powershell
docker --version
docker compose version
```

Output mong đợi:

```
Docker version 27.x.x, build xxxxxxx
Docker Compose version v2.x.x
```

> **Quan trọng:** Docker Desktop phải đang chạy (icon trong system tray) trước khi dùng bất kỳ lệnh `docker` nào.

---

## Bước 3 — Cài cloudflared (trên Windows host)

```powershell
winget install Cloudflare.cloudflared
```

Nếu không có `winget`, tải file `.msi` tại:
https://github.com/cloudflare/cloudflared/releases/latest
→ chọn `cloudflared-windows-amd64.msi` → cài đặt bình thường.

Xác nhận:

```powershell
cloudflared --version
```

Output mong đợi:

```
cloudflared version 2024.x.x (built ...)
```

---

# PHẦN 2 — CẤU TRÚC VÀ CẤU HÌNH DỰ ÁN

## Bước 4 — Kiểm Tra Cấu Trúc Thư Mục

Cấu trúc thư mục liên quan đến Docker:

```
Internship_Project/
├── docker-compose.yml               ← cấu hình toàn bộ stack (ở gốc project)
├── DB/
│   ├── DB.sql                       ← schema khởi tạo (chạy tự động lần đầu)
│   └── auth_migration.sql           ← tạo bảng users và tài khoản mặc định
├── BE/
│   ├── Dockerfile                   ← build Node.js image
│   ├── .dockerignore                ← loại trừ node_modules, .env, ...
│   ├── index.js                     ← Express server, đọc DB config từ process.env
│   ├── package.json
│   ├── package-lock.json
│   ├── login_static/
│   │   └── login.html
│   └── admin_static/
│       ├── admin.html
│       ├── admin.css
│       └── admin.js
└── FE/
    ├── dashboard.html
    ├── dashboard.css
    └── dashboard.js
```

> **Lưu ý:** `docker-compose.yml` nằm ở **gốc project** (`Internship_Project/`), không nằm trong `BE/`.

---

## Bước 5 — Kiểm Tra File Cấu Hình Docker

### 5a — File `BE/Dockerfile`

Kiểm tra file `BE/Dockerfile` có nội dung sau:

```dockerfile
# Dùng Node.js 20 trên Alpine Linux (image nhỏ gọn)
FROM node:20-alpine

# Tạo thư mục làm việc trong container
WORKDIR /app

# Copy package.json và package-lock.json trước (tận dụng Docker cache)
COPY package*.json ./

# Cài dependencies (chỉ production)
RUN npm install --omit=dev

# Copy toàn bộ source code backend vào container
COPY . .

# Expose port 3000
EXPOSE 3000

# Lệnh khởi động server
CMD ["node", "index.js"]
```

> Build context của Dockerfile là thư mục `BE/` — toàn bộ nội dung `BE/` sẽ được copy vào image (trừ những gì khai báo trong `.dockerignore`).

---

### 5b — File `BE/.dockerignore`

**Quan trọng:** Tên file phải bắt đầu bằng **dấu chấm** (`.dockerignore`), không phải dấu gạch dưới.

Kiểm tra trong `BE/` có file tên `_dockerignore` không. Nếu có, **đổi tên** thành `.dockerignore`:

```powershell
cd C:\Users\Admin\Downloads\Internship_Project\BE
Rename-Item "_dockerignore" ".dockerignore"
```

Nội dung file `.dockerignore`:

```
node_modules
npm-debug.log
.env
*.md
.git
.gitignore
```

> `.dockerignore` ngăn Docker copy `node_modules` vào image — giúp build nhanh hơn và image nhỏ hơn.

---

### 5c — File `docker-compose.yml`

File này nằm ở **gốc project** (`Internship_Project/docker-compose.yml`). Copy `.env.example` thành `.env` rồi điền `DB_PASS`, `SESSION_SECRET`, `SENSOR_API_KEY`, `ADMIN_PASSWORD`. Không commit file `.env`.

**Các điểm quan trọng trong cấu hình:**

| Thông số                                 | Giá trị              | Giải thích                                                                       |
| ------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------- |
| `DB_HOST`                                | `postgres`           | Tên service trong Docker network — backend dùng hostname này để kết nối DB |
| `DB_USER`                                | `iot_user`           | User ứng dụng — được tạo bởi`DB/DB.sql`                                  |
| `DB_PASS`                                | from `.env`          | Password của`iot_user`                                                          |
| `DB_NAME`                                | `iot_db`             | Tên database                                                                      |
| `DB_PORT`                                | `5432`               | Port nội bộ trong container (không phải 5433)                                  |
| `POSTGRES_USER`                          | `${DB_USER}` (`iot_user`) | User PostgreSQL (cũng là app user)                                          |
| `POSTGRES_PASSWORD`                      | from `.env`          | Password PostgreSQL (`DB_PASS` khi `POSTGRES_USER=iot_user`)                    |
| PostgreSQL port ngoài                     | `5433`               | Port trên Windows host để kết nối bằng pgAdmin hoặc psql                    |
| Backend port                               | `3000`               | Port trên Windows host để truy cập API                                         |
| `depends_on: condition: service_healthy` | —                     | Backend chỉ khởi động sau khi PostgreSQL sẵn sàng nhận kết nối            |

---

### 5d — File `DB/DB.sql`

File này được mount và chạy tự động khi PostgreSQL container khởi động lần đầu. File phải **không chứa** `CREATE DATABASE` hoặc lệnh `\c iot_db` — PostgreSQL Docker image tự tạo database theo `POSTGRES_DB`.

Nội dung thực tế của `DB/DB.sql`:

```sql
ALTER DATABASE iot_db SET timezone TO 'Asia/Ho_Chi_Minh';

CREATE TABLE IF NOT EXISTS "sensor_logs" (
  "id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  "timestamp_real" timestamp,
  "timestamp_up" timestamp NOT NULL,
  "received_at" timestamptz DEFAULT CURRENT_TIMESTAMP,
  "temperature" text,
  "humidity" text,
  "soil_moisture" text,
  "PUMP_state" text,
  "MODE_state" text,
  "Message" text,
  "Score" text,
  "device_id" text,
  "latency" int,
  "trigger_source" text
);

CREATE TABLE IF NOT EXISTS device_credentials (
  device_id text PRIMARY KEY,
  password  text NOT NULL
);

-- Role/password come from Docker env (DB_USER / DB_PASS), not from this file.
GRANT ALL PRIVILEGES ON TABLE sensor_logs TO iot_user;
GRANT USAGE, SELECT ON SEQUENCE sensor_logs_id_seq TO iot_user;
GRANT ALL PRIVILEGES ON TABLE device_credentials TO iot_user;
```

---

### 5e — File `DB/auth_migration.sql`

```sql
CREATE TABLE IF NOT EXISTS system_users (
  id         SERIAL PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMP DEFAULT NOW()
);

GRANT ALL PRIVILEGES ON TABLE system_users TO iot_user;
GRANT USAGE, SELECT ON SEQUENCE system_users_id_seq TO iot_user;

-- First admin is seeded by the Node backend from ADMIN_USERNAME / ADMIN_PASSWORD.
```

---

# PHẦN 3 — BUILD VÀ KHỞI ĐỘNG

## Bước 6 — Mở Terminal và Di Chuyển Vào Thư Mục Gốc Project

Mở **PowerShell** (không cần quyền Administrator) và điều hướng vào thư mục gốc project:

```powershell
cd C:\Users\Admin\Downloads\Internship_Project
```

> **Tất cả lệnh `docker compose` phải chạy từ thư mục này** — nơi chứa `docker-compose.yml`.

---

## Bước 7 — Build và Khởi Động Lần Đầu

```powershell
docker-compose up -d --build
```

Lệnh này thực hiện:

1. Build Docker image cho `backend` từ `BE/Dockerfile`
2. Pull image `postgres:16-alpine` từ Docker Hub (nếu chưa có)
3. Tạo Docker network `iot_net`
4. Tạo Docker volume `pgdata`
5. Khởi động container `iot_postgres` trước
6. Đợi PostgreSQL healthy (theo healthcheck)
7. Khởi động container `iot_backend`

Quá trình build lần đầu mất khoảng 1–3 phút tùy tốc độ mạng.

---

## Bước 8 — Xác Nhận Containers Đang Chạy

```powershell
docker compose ps
```

Output mong đợi:

```
NAME            IMAGE                COMMAND                  SERVICE    CREATED         STATUS                   PORTS
iot_backend     internship_project-backend   "docker-entrypoint.s…"   backend    2 minutes ago   Up 2 minutes             0.0.0.0:3000->3000/tcp
iot_postgres    postgres:16-alpine   "docker-entrypoint.s…"   postgres   2 minutes ago   Up 2 minutes (healthy)   0.0.0.0:5433->5432/tcp
```

**Điều kiện để tiếp tục:**

- `iot_postgres` → `STATUS` phải là `Up ... (healthy)`
- `iot_backend` → `STATUS` phải là `Up ...`

Nếu một trong hai container không chạy, xem log để tìm nguyên nhân:

```powershell
docker compose logs postgres
docker compose logs backend
```

---

# PHẦN 4 — KIỂM TRA HỆ THỐNG

## Bước 9 — Kiểm Tra Backend

Mở trình duyệt và truy cập:

```
http://localhost:3000
```

→ Sẽ tự redirect đến trang đăng nhập: `http://localhost:3000/login`

Đăng nhập với tài khoản admin đã đặt trong `.env` (`ADMIN_USERNAME` / `ADMIN_PASSWORD`). User thường do admin tạo trong dashboard.

Sau khi đăng nhập → trang `/admin/admin.html` sẽ hiển thị danh sách thiết bị (ban đầu trống).

---

## Bước 10 — Kiểm Tra Kết Nối PostgreSQL

Kết nối vào PostgreSQL qua `psql` bên trong container:

```powershell
docker exec -it iot_postgres psql -U iot_user -d iot_db
```

Kiểm tra các bảng đã được tạo:

```sql
\dt
```

Output mong đợi:

```
              List of relations
 Schema |       Name         | Type  |  Owner
--------+--------------------+-------+----------
 public | device_credentials | table | postgres
 public | sensor_logs        | table | postgres
 public | system_users       | table | postgres
```

Kiểm tra tài khoản mặc định:

```sql
SELECT id, username, role FROM system_users;
```

Output mong đợi:

```
 id | username | role
----+----------+-------
  1 | admin    | admin
  2 | user1    | user
```

Thoát psql:

```sql
\q
```

---

## Bước 11 — Kết Nối PostgreSQL Bằng pgAdmin (Tuỳ Chọn)

Nếu muốn dùng pgAdmin để quản lý database trực quan:

1. Tải và cài pgAdmin tại: https://www.pgadmin.org/download/
2. Tạo kết nối mới với thông tin:

| Trường | Giá trị              |
| -------- | ---------------------- |
| Host     | `localhost`          |
| Port     | `5433`               |
| Database | `iot_db`             |
| Username | `iot_user` (hoặc `DB_USER` trong `.env`) |
| Password | giá trị `DB_PASS` trong `.env` |

> Port phải là `5433` (port Windows host) — không phải `5432`.

---

# PHẦN 5 — CẤU HÌNH CLOUDFLARED TUNNEL

## Bước 12 — Tạo Public HTTPS Tunnel

ESP32 cần gửi dữ liệu lên Backend qua internet. cloudflared tạo một URL HTTPS công khai trỏ vào `localhost:3000`.

Mở **một terminal PowerShell mới** (giữ terminal này mở trong suốt quá trình sử dụng):

```powershell
cloudflared tunnel --protocol http2 --url http://localhost:3000
```

Sau vài giây, output sẽ hiển thị URL dạng:

```
2024-xx-xx INF +--------------------------------------------------------------------------------------------+
2024-xx-xx INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2024-xx-xx INF |  https://example-random-name.trycloudflare.com                                             |
2024-xx-xx INF +--------------------------------------------------------------------------------------------+
```

**Ghi lại URL này** — ví dụ: `https://example-random-name.trycloudflare.com`

> **Lưu ý quan trọng:** URL Quick Tunnel là ngẫu nhiên và thay đổi **mỗi lần** khởi động cloudflared. Đây là giới hạn của Quick Tunnel miễn phí. Nếu cần URL cố định, cần đăng ký Cloudflare Tunnel có trả phí.

---

## Bước 13 — Cập Nhật URL Tunnel Vào Firmware ESP32

Mở file `src/task_database.cpp`, tìm và cập nhật biến `dbUrl`:

**Trước:**

```cpp
String dbUrl = "https://old-url.trycloudflare.com/sensor";
```

**Sau:**

```cpp
String dbUrl = "https://example-random-name.trycloudflare.com/sensor";
```

> Thêm `/sensor` vào cuối URL — đây là endpoint Backend nhận dữ liệu từ ESP32 (`POST /sensor`).

---

## Bước 14 — Build và Flash Firmware

Trong VS Code với PlatformIO, chạy lệnh upload firmware (trên Windows host):

```powershell
pio run --target upload
```

Hoặc nhấn nút **Upload** trong PlatformIO IDE.

---

## Bước 15 — Xác Nhận ESP32 Gửi Dữ Liệu Thành Công

Mở Serial Monitor (115200 baud) và kiểm tra output:

```
[DB] POST thành công -> 200
```

Nếu thấy dòng này → ESP32 đã gửi dữ liệu thành công lên Backend qua tunnel.

---

# PHẦN 6 — QUẢN LÝ CONTAINER HÀNG NGÀY

## Khởi Động (Mỗi Lần Bật Máy)

Containers có `restart: unless-stopped` sẽ **tự khởi động lại** khi Docker Desktop sẵn sàng (Docker Desktop thường khởi động tự động cùng Windows).

Kiểm tra nhanh:

```powershell
cd C:\Users\Admin\Downloads\Internship_Project
docker compose ps
```

Nếu containers chưa chạy:

```powershell
docker compose up -d
```

> Không cần `--build` nếu code không thay đổi — Docker sẽ dùng image đã build từ trước.

---

## Dừng Containers

```powershell
docker compose stop
```

> Dữ liệu PostgreSQL vẫn được giữ nguyên trong volume `pgdata`.

---

## Xem Logs Real-time

```powershell
# Toàn bộ stack
docker compose logs -f

# Chỉ backend
docker compose logs -f backend

# Chỉ PostgreSQL
docker compose logs -f postgres
```

Nhấn `Ctrl+C` để thoát khỏi chế độ xem log.

---

## Rebuild Sau Khi Sửa Code Backend

```powershell
docker compose up -d --build backend
```

> Chỉ rebuild container `backend` — không ảnh hưởng PostgreSQL và dữ liệu.

---

## Truy Cập psql Trong Container

```powershell
docker exec -it iot_postgres psql -U iot_user -d iot_db
```

Các lệnh psql thường dùng:

```sql
-- Xem số lượng bản ghi sensor
SELECT COUNT(*) FROM sensor_logs;

-- Xem 10 bản ghi mới nhất
SELECT device_id, temperature, humidity, soil_moisture, "PUMP_state", received_at
FROM sensor_logs
ORDER BY id DESC
LIMIT 10;

-- Xem danh sách thiết bị (mỗi thiết bị 1 dòng)
SELECT DISTINCT ON (device_id) device_id, temperature, humidity, received_at
FROM sensor_logs
ORDER BY device_id, received_at DESC;

-- Xem danh sách user hệ thống
SELECT id, username, role, created_at FROM system_users;

-- Xem mật khẩu thiết bị
SELECT * FROM device_credentials;

-- Thoát
\q
```

---

## Xóa Toàn Bộ và Reset Sạch

```powershell
# Dừng và xóa containers, networks, volumes (XÓA HẾT DỮ LIỆU DB!)
docker compose down -v

# Khởi động lại từ đầu (build lại image)
docker compose up -d --build
```

> **Cảnh báo:** Flag `-v` xóa Docker volume `pgdata` → **mất toàn bộ dữ liệu** trong PostgreSQL. Chỉ dùng khi cần reset hoàn toàn.

---

## Xóa Containers Nhưng Giữ Dữ Liệu

```powershell
# Dừng và xóa containers, networks — GIỮ NGUYÊN volume pgdata
docker compose down

# Khởi động lại
docker compose up -d
```

---

# PHẦN 7 — XỬ LÝ SỰ CỐ

## Backend Báo Lỗi Kết Nối DB

**`Error: password authentication failed for user "iot_user"`**

→ User `iot_user` chưa được tạo. SQL init chưa chạy (thường do volume cũ đã có data, bỏ qua init script). Xóa volume và khởi động lại:

```powershell
docker compose down -v
docker compose up -d --build
```

---

**`Error: getaddrinfo ENOTFOUND postgres`**

→ Backend không tìm thấy hostname `postgres`. Kiểm tra:

- `docker-compose.yml` có dòng `DB_HOST: postgres` không
- `BE/index.js` đọc `process.env.DB_HOST` không (không hardcode `localhost`)
- Cả hai container có cùng network `iot_net` không

Sau khi sửa: `docker compose up -d --build backend`

---

**`Error: connect ECONNREFUSED 172.x.x.x:5432`**

→ Backend khởi động trước khi PostgreSQL sẵn sàng. Thường không xảy ra vì đã có `depends_on: condition: service_healthy`. Nếu vẫn xảy ra:

```powershell
docker compose restart backend
```

---

## PostgreSQL Container Không Healthy

```powershell
docker compose logs postgres
```

Nguyên nhân thường gặp:

- SQL init script có lỗi cú pháp → xem log để tìm dòng lỗi cụ thể
- `DB.sql` còn lệnh `CREATE DATABASE` hoặc `\c iot_db` → xóa đi (PostgreSQL Docker tự tạo database theo `POSTGRES_DB`)
- Volume cũ bị corrupt → `docker compose down -v` rồi up lại

---

## Backend Container Không Start

```powershell
docker compose logs backend
```

**`Cannot find module 'express'`** hoặc **`Cannot find module 'pg'`**

→ `npm install` chưa chạy đúng. Rebuild image:

```powershell
docker compose up -d --build backend
```

---

**`EADDRINUSE: address already in use :::3000`**

→ Port 3000 trên Windows bị chiếm bởi process khác:

```powershell
netstat -ano | findstr :3000
# Tìm PID và kill:
taskkill /PID <PID> /F
```

Sau đó: `docker compose up -d`

---

## ESP32 Báo POST Thất Bại

| Lỗi                                | Nguyên nhân                                      | Cách xử lý                                  |
| ----------------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| `connection refused`              | Backend container chưa chạy                      | `docker compose up -d`                       |
| `ssl handshake failed`            | Thiếu`WiFiClientSecure` hoặc `setInsecure()` | Kiểm tra`task_database.cpp`                 |
| `-1` hoặc `connection timeout` | Tunnel chưa chạy hoặc URL sai                   | Kiểm tra terminal cloudflared, cập nhật URL |
| `HTTP 404`                        | URL sai hoặc endpoint sai                         | Đảm bảo URL kết thúc bằng`/sensor`     |
| `HTTP 500`                        | Backend lỗi khi xử lý request                   | Xem`docker compose logs backend`             |

---

## URL Tunnel Thay Đổi Sau Khi Restart cloudflared

Đây là giới hạn của Quick Tunnel. Khi URL thay đổi:

1. Sao chép URL mới từ terminal cloudflared
2. Cập nhật `dbUrl` trong `src/task_database.cpp`
3. Build và flash lại firmware qua PlatformIO

**Cách giảm thiểu:** Không tắt terminal chạy cloudflared trong suốt thời gian sử dụng.

---

## Port 5433 Không Kết Nối Được Từ pgAdmin

→ Kiểm tra:

```powershell
# Xác nhận PostgreSQL container đang chạy và healthy
docker compose ps

# Xác nhận port 5433 đang được lắng nghe
netstat -ano | findstr :5433
```

Nếu container đang chạy nhưng không kết nối được → thử tắt Windows Firewall tạm thời để kiểm tra.

---

## Xem Tất Cả Containers Và Images

```powershell
# Xem containers đang chạy
docker ps

# Xem tất cả containers (kể cả đã dừng)
docker ps -a

# Xem images đã build
docker images
```

---

## Xóa Image Cũ Sau Khi Rebuild Nhiều Lần

```powershell
# Xóa các image không còn được dùng (dangling images)
docker image prune -f
```

---

# PHẦN 8 — THÔNG TIN THAM KHẢO

## Thông Tin Kết Nối

| Thành phần              | Địa chỉ                        | Ghi chú                             |
| ------------------------- | --------------------------------- | ------------------------------------ |
| Backend API               | `http://localhost:3000`         | Từ Windows host                     |
| Backend (public)          | `https://xxx.trycloudflare.com` | Qua cloudflared tunnel               |
| PostgreSQL (từ Windows)  | `localhost:5433`                | Dùng cho pgAdmin, psql native       |
| PostgreSQL (trong Docker) | `postgres:5432`                 | Chỉ dùng nội bộ giữa containers |

---

## Tài Khoản

| Loại                 | Username     | Password               | Ghi chú                               |
| --------------------- | ------------ | ---------------------- | -------------------------------------- |
| Quản trị hệ thống | `ADMIN_USERNAME` | `ADMIN_PASSWORD` | Seed lần đầu khi `system_users` trống |
| PostgreSQL            | `DB_USER`    | `DB_PASS`              | File `.env`                            |

Đổi mật khẩu admin từ trang quản trị. Không ghi mật khẩu plaintext vào SQL.

---

## Các API Endpoint Backend

| Method     | Endpoint                                | Auth    | Mô tả                                    |
| ---------- | --------------------------------------- | ------- | ------------------------------------------ |
| `POST`   | `/sensor`                             | `X-Device-Key` | ESP32 gửi dữ liệu cảm biến            |
| `GET`    | `/login`                              | Không  | Trang đăng nhập                         |
| `POST`   | `/login`                              | Rate-limit | Xử lý đăng nhập                       |
| `POST`   | `/register`                           | Tắt    | Chỉ admin tạo tài khoản                |
| `POST`   | `/logout`                             | Session | Đăng xuất                               |
| `GET`    | `/api/me`                             | Session | Thông tin user hiện tại                 |
| `GET`    | `/admin/api/devices`                  | Session | Danh sách thiết bị                      |
| `GET`    | `/admin/api/devices/:id/history`      | Session | Lịch sử dữ liệu thiết bị             |
| `DELETE` | `/admin/api/devices/:id`              | Admin   | Xóa thiết bị                            |
| `POST`   | `/admin/api/devices/:id/verify`       | Session | Xác thực mật khẩu thiết bị           |
| `GET`    | `/admin/api/devices/:id/has-password` | Admin   | Kiểm tra thiết bị có mật khẩu không |
| `POST`   | `/admin/api/devices/:id/password`     | Admin   | Đặt mật khẩu thiết bị                |
| `DELETE` | `/admin/api/devices/:id/password`     | Admin   | Xóa mật khẩu thiết bị                 |
| `GET`    | `/admin/api/users`                    | Admin   | Danh sách user hệ thống                 |
| `POST`   | `/admin/api/users`                    | Admin   | Tạo user mới                             |
| `DELETE` | `/admin/api/users/:id`                | Admin   | Xóa user                                  |

---

# TÓM TẮT THỨ TỰ THỰC HIỆN

```
Bước 1  → Cài WSL2: wsl --install → restart Windows
Bước 2  → Cài Docker Desktop → restart Windows → đợi "Engine running"
Bước 3  → Cài cloudflared: winget install Cloudflare.cloudflared
Bước 4  → Kiểm tra cấu trúc thư mục project
Bước 5  → Xác nhận các file:
           BE/Dockerfile
           BE/.dockerignore  ← dấu chấm, không phải gạch dưới
           docker-compose.yml  ← ở gốc project
           DB/DB.sql  ← không có CREATE DATABASE / \c
           DB/auth_migration.sql
Bước 6  → cd vào thư mục gốc project (nơi có docker-compose.yml)
Bước 7  → docker compose up -d --build  (lần đầu — build image + khởi động)
Bước 8  → docker compose ps  → xác nhận cả hai container "Up"/"healthy"
Bước 9  → Trình duyệt: http://localhost:3000 → thấy trang login
           Đăng nhập bằng ADMIN_USERNAME / ADMIN_PASSWORD trong .env
Bước 10 → docker exec -it iot_postgres psql -U iot_user -d iot_db
           → \dt (xác nhận 3 bảng đã tạo) → \q
Bước 11 → Mở terminal mới: cloudflared tunnel --url http://localhost:3000
           → ghi lại URL https://xxx.trycloudflare.com
Bước 12 → Cập nhật dbUrl trong src/task_database.cpp với URL tunnel mới
Bước 13 → pio run --target upload  (flash firmware trên Windows host)
Bước 14 → Mở Serial Monitor 115200 baud
           → xác nhận "[DB] POST thành công -> 200"
Bước 15 → Trình duyệt: http://localhost:3000/admin/admin.html
           → thiết bị ESP32 xuất hiện trong danh sách
```
