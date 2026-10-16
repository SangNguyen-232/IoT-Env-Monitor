# Nâng cấp hệ thống — 16/10/2026

**Trạng thái:** đã triển khai Docker/Worker và nạp firmware ESP32; xem mục triển khai cuối tài liệu.

Các phiên bản ổn định đã đối chiếu với npm, PyPI và release chính thức tại thời điểm nâng cấp:

- Node.js **26.12.0**, npm **12.2.0**, Alpine **3.24**. Dùng `nvm use` hoặc image trong `BE/Dockerfile`.
- Backend: Express **5.3.0**, express-session **1.19.0**, pg **8.23.1**, connect-pg-simple **10.0.0**, bcryptjs **3.0.3**, Helmet **8.3.0**. Các phiên bản này đã có trước đợt nâng cấp và vẫn là bản mới nhất.
- Worker: Wrangler **4.151.0**, Vitest **5.0.5**, Cloudflare Vitest plugin **1.4.3**. `npm test` chạy một lần; `npm run test:watch` theo dõi thay đổi. Test dùng binding giả lập cục bộ; cấu hình VPC triển khai giữ trong `wrangler.jsonc`.
- Firmware: Espressif32 **7.1.3**, ESPAsyncWebServer **3.12.1**, AsyncTCP **3.5.0**, NeoPixel **1.15.5**, ArduinoJson **7.4.3**, ElegantOTA **4.0.0**, DHT20 **0.3.3**. ArduinoJson, ElegantOTA và DHT20 được quản lý bằng PlatformIO, thay cho bản chép trong `lib/` vốn che khuất thư viện mới.
- TensorFlowLite_ESP32 **1.0.0** vẫn là release mới nhất của thư viện đang dùng. Driver LCD trong `lib/LCD` được giữ vì là bản cục bộ, không có metadata xác định một gói upstream tương đương để thay thế an toàn. Arduino framework đi theo platform chính thức đã ghim; không tự thay bằng một core ngoài platform.
- Python **3.12+**, NumPy **2.5.4**, TensorFlow **2.21.0**. Python 3.11 không cài được NumPy 2.5. Exporter kiểm tra schema, toán tử float32 v1, kích thước tensor và so sánh 32 dự đoán trước khi ghi model. Model đã huấn luyện trong kho không bị thay bằng model thử nghiệm.
- Dashboard: Chart.js **4.5.1** được ghim URL UMD; Leaflet **1.9.4** vẫn là stable mới nhất.
- Docker: PostgreSQL **18.6-alpine3.24**, cloudflared **2026.10.1**. PostgreSQL 19 hiện là RC, nên chưa dùng cho vận hành.

## PostgreSQL đang có dữ liệu: chuyển 16 sang 18

**Không chạy `docker compose up` với cấu hình mới trước khi hoàn tất sao lưu.** PostgreSQL 18 không thể đọc trực tiếp data directory của 16. Compose mới dùng volume riêng `pgdata18` tại `/var/lib/postgresql`; volume cũ `pgdata` được giữ để quay lại. Nếu dùng project name tùy chỉnh, thêm cùng `-p <project-name>` vào mọi lệnh Compose. Các lệnh dưới đây giả định stack đang chạy bằng cấu hình PostgreSQL 16 cũ và tên container mặc định của dự án.

1. Dừng nguồn ghi và tạo bản sao lưu khi PostgreSQL 16 vẫn chạy:

   ```bash
   umask 077
   mkdir -p backups
   docker compose stop cloudflared backend
   docker exec iot_postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > backups/postgres16.dump
   docker exec -i iot_postgres pg_restore --list < backups/postgres16.dump > backups/postgres16.contents
   test -s backups/postgres16.contents
   ```

   Chỉ tiếp tục khi mọi lệnh thành công. Nếu có ứng dụng khác ghi trực tiếp vào DB, dừng chúng trước khi dump. Giữ bản dump ngoài máy chủ theo chính sách sao lưu của bạn.

2. Khởi động PostgreSQL 18 trên volume mới và phục hồi:

   ```bash
   docker compose stop postgres
   docker compose up -d --wait postgres
   docker compose exec -T postgres sh -c 'pg_restore --exit-on-error --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < backups/postgres16.dump
   docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "ANALYZE;"'
   ```

   Giữ nguyên `DB_USER`, `DB_NAME`, `DB_PASS` trong `.env` trong suốt quá trình. Lệnh restore có `--clean`: chỉ chạy trên DB 18 vừa tạo từ bước này. Không chạy lại trên DB đã tiếp nhận dữ liệu mới.

3. Đối chiếu số bản ghi/các tài khoản, rồi khởi động backend:

   ```bash
   docker compose up -d --build --wait backend
   docker compose logs --tail=50 backend
   docker compose up -d cloudflared
   ```

   Kiểm tra đăng nhập admin/user, danh sách thiết bị, lịch sử cảm biến và dữ liệu mới từ ESP32. Giữ volume 16 và bản dump cho tới khi xác nhận hệ thống hoạt động ổn định. Không dùng `docker compose down -v` trong quá trình chuyển đổi.

### Quay lại PostgreSQL 16

File `DB/compose.postgres16.yml` cần Docker Compose **2.24.4+** (`!override`). Nếu chưa có dữ liệu mới trên 18:

```bash
docker compose stop cloudflared backend postgres
docker compose -f docker-compose.yml -f DB/compose.postgres16.yml up -d --wait postgres backend
docker compose -f docker-compose.yml -f DB/compose.postgres16.yml up -d cloudflared
```

Lệnh này gắn lại volume 16 ban đầu. Nếu 18 đã nhận dữ liệu mới, sao lưu 18 và lập kế hoạch đối soát trước khi quay lại; volume 16 không chứa những bản ghi mới đó. `pg_dump` từ 18 không được đảm bảo có thể phục hồi trực tiếp về 16.

## Cài đặt và kiểm tra mã nguồn

```bash
nvm use
(cd BE && npm ci && npm run check)
(cd cloudflare-worker && npm ci && npm test && npm run check)
pio run -e yolo_uno
pio run -e yolo_uno --target buildfs

python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install -r ml/requirements.txt
# Optional flash backup / LittleFS maintenance:
python -m pip install -r scripts/requirements.txt
python -m pip check
# Chỉ kiểm tra pipeline; không ghi đè model/dataset trong kho:
python ml/train_export.py --epochs 1 --output-dir /tmp/iot-ml-check
# Huấn luyện thật và thay model trong kho khi cần:
# python ml/train_export.py
```

Test backend cần một PostgreSQL riêng và tài khoản có quyền `CREATE DATABASE`. Test tự tạo/xóa database có tên ngẫu nhiên; không dùng thông tin kết nối production:

```bash
cd BE
DB_TEST_URL=postgresql://test_user:test_password@127.0.0.1:55432/postgres npm test
```

Nếu thiếu `DB_TEST_URL`, kiểm thử tích hợp được đánh dấu skip. Cổng backend mặc định vẫn là 3000; có thể đặt `PORT` khi chạy nhiều instance thử nghiệm.

Build Docker: `docker build -t iot-backend-upgraded ./BE`. File `.dockerignore` loại `node_modules` trên host để tránh ghi đè dependency cài trong image.

## Nguồn phiên bản và hướng dẫn tương thích

- [Node.js release metadata](https://nodejs.org/dist/index.json), [npm registry](https://registry.npmjs.org/).
- [Espressif32 releases](https://github.com/platformio/platform-espressif32/releases), [ArduinoJson 6 → 7](https://arduinojson.org/v7/how-to/upgrade-from-v6/), [ElegantOTA 4](https://github.com/ayushsharma82/ElegantOTA/releases/tag/4.0.0).
- [TensorFlow trên PyPI](https://pypi.org/project/tensorflow/), [NumPy trên PyPI](https://pypi.org/project/numpy/).
- [PostgreSQL versioning và major upgrade](https://www.postgresql.org/support/versioning/), [PostgreSQL Docker image và PGDATA 18+](https://hub.docker.com/_/postgres).
- [cloudflared releases](https://github.com/cloudflare/cloudflared/releases).

## Kết quả xác minh cục bộ

- Biên dịch ESP32-S3 và đóng gói LittleFS thành công trước triển khai; thư viện TensorFlowLite_ESP32 vẫn có một số cảnh báo compiler từ upstream.
- Cài sạch `npm ci`, kiểm tra cú pháp backend và 5 kiểm thử Worker thành công; `wrangler deploy --dry-run` thành công. `npm audit` ở cả hai thư mục không báo lỗ hổng.
- Kiểm thử backend với DB PostgreSQL 18.6 riêng thành công: quyền truy cập ẩn danh, chặn telemetry sai, ghi cảm biến, bcrypt login, session lưu trong PostgreSQL, dashboard và logout.
- Diễn tập `pg_dump` PostgreSQL 16 → `pg_restore` PostgreSQL 18 trên dữ liệu giả: giữ nguyên bản ghi cảm biến, tài khoản và gán thiết bị.
- Python 3.12 + TensorFlow 2.21 + NumPy 2.5.4: `pip check`, huấn luyện thử 1 epoch, chuyển đổi model, kiểm tra toán tử và đối chiếu 32 dự đoán thành công. Model thử nghiệm chỉ nằm trong `/tmp`.
- Image backend cuối cùng chạy thành công với Node 26.12.0, user thường (UID 1000), đăng nhập và session PostgreSQL 18.6. Các container thử nghiệm đã được dọn.
- Các kiểm tra cục bộ trên được thực hiện trước triển khai. Trạng thái vận hành sau nâng cấp được ghi trong mục bên dưới.

## Đã triển khai lên hệ thống — 16/10/2026

- PostgreSQL vận hành đã chuyển từ 16.15 sang **18.6**, dùng volume `iot-env-monitor_pgdata18`. Dữ liệu mọi bảng khớp fingerprint ngay sau restore; volume `iot-env-monitor_pgdata` cũ vẫn được giữ.
- Backend mới chạy **Node 26.12.0 / npm 12.2.0**, user thường. Container backend và PostgreSQL healthy; tunnel dùng **cloudflared 2026.10.1**.
- Worker `iot-env-monitor-sys` đã triển khai, version **499b2815-41a3-4d1e-b391-e43570d12b47**. URL: [IoT Env Monitor](https://iot-env-monitor-sys.sangnguyen232.workers.dev).
- Kiểm tra public thành công: admin login/logout, Secure session cookie, dashboard, danh sách thiết bị và POST cảm biến với header như ESP32. Bản ghi cảm biến thử đã được xóa.
- Đã cài `.venv` Python 3.12 với dependency ML mới và công cụ `scripts/requirements.txt`. Kích hoạt bằng `source .venv/bin/activate`.
- Đã sao lưu đầy đủ 8 MB flash ESP32, nạp firmware và LittleFS mới qua `/dev/ttyACM0`, xác minh hash sau ghi. URL backend trong cấu hình cục bộ của firmware và `server.json` trên thiết bị đã trỏ tới Worker thật. Khi dùng esptool trực tiếp, dùng `--flash-mode dio` (đúng header bootloader và cách PlatformIO nạp ESP32-S3); không ép bootloader sang QIO.
- Thiết bị trước nâng cấp chưa có Wi-Fi station hoặc danh sách Wi-Fi đã lưu. Khi cần gửi telemetry thật, kết nối vào Wi-Fi AP của ESP32, mở `http://192.168.4.1`, dùng tài khoản thiết bị trong `include/secrets.h` rồi nhập Wi-Fi tại Settings. Không đưa mật khẩu vào tài liệu hoặc Git.

Bản sao lưu riêng của lần triển khai: `backups/upgrade-20261016-011021`. Thư mục chỉ chủ tài khoản được truy cập và bị loại khỏi Git. Có DB dump, globals, fingerprint trước/sau, flash cũ, LittleFS và cấu hình rollback dùng đúng image cũ.

Nếu cần quay lại runtime cũ trước khi có dữ liệu mới, dừng stack rồi dùng `docker compose -f docker-compose.yml -f <backup-directory>/rollback.yml up -d --no-build --wait postgres backend cloudflared`. Nếu đã có dữ liệu mới, sao lưu và đối soát trước. Không xóa volume cũ hoặc backup.

Kiểm tra phần cứng sau nạp: boot DIO bình thường, AP `192.168.4.1` hoạt động; ghi nhận 6 lượt TinyML (gồm dữ liệu DHT20 thật), không có crash/reset lặp trong thời gian theo dõi. Báo cáo và log nằm trong thư mục backup riêng ở trên.
