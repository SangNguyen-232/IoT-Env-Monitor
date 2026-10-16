# Hướng dẫn chạy dự án từ bản clone mới

Với **máy mới và bản clone đầy đủ**, bạn cần thiết lập một lần theo thứ tự: **cấu hình → chạy server → nối Cloudflare → nạp ESP32 → kiểm tra dữ liệu**.

Lưu ý tại thời điểm viết hướng dẫn: ở bản local hiện tại, `cloudflare-worker/` vẫn chưa được Git theo dõi. Quy trình dưới giả định phần này đã được commit/push và có trong bản clone.

## 1. Chuẩn bị công cụ và clone đúng nhánh

Máy cần có Git, Docker Engine kèm Compose, Node.js 22/npm và PlatformIO. Có thể cài PlatformIO qua extension trong VS Code; extension đã bao gồm PlatformIO Core. [Hướng dẫn PlatformIO](https://docs.platformio.org/en/latest/core/installation/index.html).

```bash
git clone --branch project_linux https://github.com/SangNguyen-232/IoT-Env-Monitor.git
cd IoT-Env-Monitor
```

Kiểm tra công cụ:

```bash
docker compose version
node --version
npm --version
pio --version
```

## 2. Tạo cấu hình riêng cho máy mới

Từ thư mục gốc dự án:

```bash
cp .env.example .env
cp include/secrets.h.example include/secrets.h
```

Sửa `.env`, thay các giá trị mẫu:

- `DB_PASS`: mật khẩu PostgreSQL.
- `SESSION_SECRET`: chuỗi ngẫu nhiên dài.
- `SENSOR_API_KEY`: khóa dùng chung giữa backend và ESP32.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD`: tài khoản quản trị ban đầu.
- `CLOUDFLARE_TUNNEL_TOKEN`: token tunnel ở bước tiếp theo.

Có thể tạo chuỗi ngẫu nhiên bằng:

```bash
openssl rand -hex 32
```

Với Docker Compose hiện tại, mật khẩu PostgreSQL lấy từ **`DB_PASS`**; biến `POSTGRES_PASSWORD` trong file mẫu không được Compose sử dụng trực tiếp. Các thông số host/port kết nối backend đến database đã được Compose đặt theo mạng container.

## 3. Tạo Cloudflare Tunnel và chạy server

Trong Cloudflare Dashboard, tạo **Cloudflare Tunnel loại cloudflared**, lấy token rồi điền vào `CLOUDFLARE_TUNNEL_TOKEN` trong `.env`.

Không cần cài thêm `cloudflared` trên máy host vì dự án đã chạy nó trong Docker.

Sau đó:

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 backend cloudflared
```

Kết quả mong đợi:

- `postgres`: healthy.
- `backend`: healthy.
- `cloudflared`: đang chạy và tunnel báo đã kết nối.

Với **database mới hoàn toàn**, Docker tự chạy `DB.sql` và `auth_migration.sql`; backend tự tạo tài khoản admin ban đầu. **Không chạy `timezone_migration.sql` cho database mới** — file đó dành cho dữ liệu cũ.

## 4. Kết nối và triển khai Cloudflare Worker

Trong Cloudflare, tạo **VPC Service** với:

- Loại dịch vụ: HTTP.
- Tunnel: tunnel vừa tạo.
- Hostname: `backend`.
- HTTP port: `3000`.
- DNS resolver: dùng tunnel.

Hostname `backend` được phân giải trong mạng Docker mà container `cloudflared` tham gia; không dùng `localhost` để trỏ đến backend ở cấu hình này. Cloudflare hướng dẫn tạo Tunnel, VPC Service và liên kết Worker trong [quy trình Workers VPC](https://developers.cloudflare.com/workers-vpc/get-started/).

Lấy **Service ID**, sửa `service_id` trong `cloudflare-worker/wrangler.jsonc`, giữ binding là `IOT_BACKEND`.

Nếu dùng tài khoản Cloudflare khác, không giữ nguyên Service ID của môi trường cũ.

Chạy từ thư mục gốc:

```bash
cd cloudflare-worker
npm ci
npx wrangler login
npm run deploy
cd ..
```

Ghi lại URL HTTPS mà Wrangler trả về. Mở URL đó với đường dẫn `/login`, đăng nhập bằng tài khoản admin đã cấu hình.

**Cổng backend hiện chỉ nằm trong mạng Docker**, nên bạn truy cập qua Worker; `http://localhost:3000` chưa được mở ra host.

## 5. Cấu hình và nạp ESP32

Sửa `include/secrets.h`:

- `SSID_AP`, `PASS_AP`: tên và mật khẩu Wi-Fi do ESP32 phát; mật khẩu ít nhất 8 ký tự.
- `DEVICE_HTTP_USER`, `DEVICE_HTTP_PASS`: tài khoản truy cập dashboard của ESP32.
- `SENSOR_API_KEY`: giống hệt `.env`.
- `SENSOR_API_URL`: URL HTTPS của Worker, **không cần thêm `/sensor`**.

Cắm ESP32 qua USB, kiểm tra cổng:

```bash
pio device list
```

Sửa `upload_port` và `monitor_port` trong `platformio.ini` nếu cổng thực tế khác `/dev/ttyACM0`.

Nạp firmware và giao diện:

```bash
pio run --target upload
pio run --target uploadfs
pio device monitor
```

`uploadfs` nạp nội dung `FE/` vào LittleFS. Với thiết bị đã sử dụng, thao tác này có thể ghi đè cấu hình Wi-Fi và URL đã lưu trên filesystem.

## 6. Kết nối Wi-Fi và kiểm tra toàn hệ thống

Sau lần nạp mới:

1. Kết nối máy tính/điện thoại vào Wi-Fi AP của ESP32.
2. Mở [dashboard thiết bị](http://192.168.4.1).
3. Vào cài đặt, nhập Wi-Fi nhà và URL Worker.
4. Nhấn **Lưu & Kết nối**.
5. Kết nối lại máy tính/điện thoại vào mạng nhà.
6. Mở URL Worker với đường dẫn `/admin`.

Thiết bị gửi dữ liệu thành công sẽ xuất hiện trên trang quản trị. Tài khoản đăng nhập Web Admin và tài khoản HTTP của ESP32 là **hai bộ thông tin cấu hình riêng**.

## Những lần chạy tiếp theo

Những lần bật máy tiếp theo, bạn thường chỉ cần:

```bash
docker compose up -d
```

Sau đó cấp nguồn ESP32. Worker đã triển khai vẫn chạy trên Cloudflare; chỉ cần deploy lại khi sửa mã Worker.
