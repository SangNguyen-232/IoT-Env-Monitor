# Cấu trúc mã nguồn IoT-Env-Monitor

Sơ đồ mô tả mã nguồn, cấu hình và tài liệu hiện tại. Các thư viện trong `lib/` được liệt kê đến thư mục gốc; các thư mục Git, dependency cài đặt và cache/build không được triển khai chi tiết. `.env` và `include/secrets.h` là file cấu hình cục bộ, không đưa lên Git.

```text
IoT-Env-Monitor/
├── .vscode/                                # Cấu hình workspace VS Code (extensions & settings)
│   ├── extensions.json                     # Khuyến nghị extension PlatformIO
│   └── settings.json                       # Cấu hình nhận diện file C++, ESP-IDF và CMake của workspace
├── BE/                                     # Node.js Express Backend & Web Admin
│   ├── admin_static/                       # Giao diện Web Admin quản trị thiết bị tập trung (Admin Dashboard)
│   │   ├── admin.css                       # CSS giao diện quản trị responsive, dark mode, animation
│   │   ├── admin.html                      # Khung HTML Admin: danh sách card thiết bị, modal tạo user, phân quyền, quản lý mật khẩu thiết bị, duyệt yêu cầu truy cập realtime
│   │   └── admin.js                        # Polling thiết bị theo card_key (MAC + IP LAN), trạng thái online/offline theo age_seconds, phân quyền MAC/IP, xin ticket HMAC, duyệt yêu cầu truy cập và kết nối WebSocket LAN
│   ├── login_static/                       # Trang Web đăng nhập hệ thống
│   │   └── login.html                      # Giao diện đăng nhập tài khoản hệ thống (Admin / User)
│   ├── .dockerignore                       # Danh sách loại trừ khi build Docker image backend (node_modules, .env, *.md, .git)
│   ├── Dockerfile                          # Dockerfile build image backend trên nền node:20-alpine (cài tzdata Asia/Ho_Chi_Minh, npm ci --omit=dev, chạy user node bảo mật)
│   ├── index.js                            # Express REST API: nhận /sensor, session PostgreSQL, bcrypt, rate limit, ticket HMAC, phân quyền MAC/IP LAN, nâng cấp schema và dọn log cũ; yêu cầu truy cập lưu trong RAM
│   ├── package.json                        # Khai báo dependency (express, pg, bcryptjs, express-session, connect-pg-simple, helmet)
│   └── package-lock.json                   # Khóa phiên bản các package phụ thuộc
├── boards/                                 # Cấu hình phần cứng board mạch PlatformIO
│   └── yolo_uno.json                       # Định nghĩa board YOLO UNO (ESP32-S3-WROOM-1, Flash 8MB, LittleFS)
├── cloudflare-worker/                      # Cloudflare Worker proxy công khai (chuyển từ iot-env-monitor-public vào cùng repo)
│   ├── src/
│   │   └── index.js                        # Chuyển tiếp request tới http://backend:3000 qua env.IOT_BACKEND; bổ sung header proxy, trả 502 khi kết nối lỗi
│   ├── test/
│   │   └── index.spec.js                   # Test mẫu Vitest còn kiểm tra "Hello World!", chưa cập nhật cho logic proxy
│   ├── .editorconfig                       # Quy ước thụt lề, encoding và kết thúc dòng
│   ├── .gitignore                          # Loại trừ node_modules, .wrangler, .env* và .dev.vars*; giữ file mẫu
│   ├── .prettierrc                         # Cấu hình định dạng mã Worker
│   ├── package.json                        # Package iot-env-monitor-public: script dev/start, deploy và test; dependency Wrangler và Vitest
│   ├── package-lock.json                   # Khóa phiên bản dependency của Worker, độc lập với BE/
│   ├── vitest.config.mjs                   # Cấu hình @cloudflare/vitest-plugin dùng wrangler.jsonc
│   └── wrangler.jsonc                      # Worker tên iot-env-monitor, entry src/index.js, workers_dev và VPC Service binding IOT_BACKEND
├── data/                                   # Dữ liệu flash trích xuất từ ESP32
│   └── wifi_info.json.example              # Mẫu kết quả trích xuất; wifi_info.json thực tế được tạo bởi scripts/pull_wifi_info.py (gitignored)
├── DB/                                     # Script cơ sở dữ liệu PostgreSQL
│   ├── DB.sql                              # Khởi tạo sensor_logs (số thực, timestamptz, MAC/IP LAN, index theo device_id và thời gian) và device_credentials (bcrypt)
│   ├── auth_migration.sql                  # Khởi tạo system_users (bcrypt, role admin/user) và user_devices; backend bổ sung lan_ip và khóa chính (user_id, device_id, lan_ip)
│   └── timezone_migration.sql              # Chạy thủ công một lần cho DB cũ: đổi timestamp cảm biến từ UTC+7 và created_at từ UTC sang timestamptz
├── FE/                                     # Giao diện Web nhúng của ESP32 (Thư mục nạp vào LittleFS qua data_dir = FE)
│   ├── dashboard.css                       # CSS hiển thị chỉ số cảm biến, gauge, layout responsive, dark mode
│   ├── dashboard.html                      # HTML dashboard nhúng: thẻ gauge nhiệt độ/độ ẩm/đất, bản đồ Leaflet, đồ thị Chart.js, nút bật/tắt bơm & đổi mode, modal cài đặt Wi-Fi + URL server
│   └── dashboard.js                        # WebSocket /ws với token từ /api/ws-token, cập nhật cảm biến/bơm, bản đồ và đồ thị; lưu Wi-Fi và URL backend
├── include/                                # Header files C++ cho firmware ESP32
│   ├── dht_anomaly_model.h                 # Mô hình TinyML (TFLite Micro) dạng mảng C byte array nhúng trực tiếp vào Flash
│   ├── global.h                            # SharedContext, Mutex (mutexContext), Semaphore đồng bộ FreeRTOS, khai báo biến toàn cục
│   ├── led_blinky.h                        # Khai báo Task LED GPIO48 cảnh báo nhiệt độ
│   ├── neo_blinky.h                        # Khai báo Task NeoPixel RGB GPIO45 cảnh báo độ ẩm không khí
│   ├── project_includes.h                  # Tập trung include các thư viện hệ thống cần thiết
│   ├── pump.h                              # Khai báo Task điều khiển máy bơm relay GPIO10 (bảo vệ timeout, cooldown, auto-fault)
│   ├── risk_label.h                        # Định nghĩa ngưỡng rủi ro Normal/Warning/Critical và thuật toán tính nhãn rủi ro môi trường
│   ├── secrets.h                           # Tạo cục bộ từ secrets.h.example; thông số bảo mật thật: Wi-Fi AP, HTTP Basic Auth, OTA Auth, SENSOR_API_KEY, SENSOR_API_URL (gitignored)
│   ├── secrets.h.example                   # File mẫu cấu hình secrets
│   ├── serial_log.h                        # Khai báo hàm in log Serial an toàn với Mutex
│   ├── task_check_info.h                   # Khai báo hàm quản lý LittleFS: /info.dat, /wifi_list.json, /server.json, kiểm tra I2C
│   ├── task_database.h                     # Khai báo Task gửi HTTPS POST /sensor đệm hàng đợi (POST_QUEUE_MAX 6) kèm header X-Device-Key
│   ├── task_handler.h                      # Khai báo hàm xử lý message WebSocket từ client nhúng
│   ├── task_toogle_boot.h                  # Khai báo Task xử lý nút cứng BOOT GPIO0 (nhấn giữ >2s để reset Wi-Fi)
│   ├── task_webserver.h                    # Khai báo hàm máy chủ web nhúng ESPAsyncWebServer (cổng 80), WebSocket (/ws), cấp /api/ws-token, ElegantOTA
│   ├── task_wifi.h                         # Khai báo hàm quản lý kết nối Wi-Fi (STA & AP Captive Portal, NTP time)
│   ├── temp_humi_monitor.h                 # Khai báo Task đọc cảm biến DHT20, ADC độ ẩm đất GPIO2, màn hình LCD 16x2
│   └── tinyml.h                            # Khai báo Task suy luận TensorFlow Lite Micro trên ESP32
├── lib/                                    # Thư viện C++ cục bộ dự án
│   ├── ArduinoJson/                        # Thư viện xử lý và parse JSON (v6)
│   ├── DHT20/                              # Driver giao tiếp cảm biến nhiệt độ & độ ẩm DHT20 qua I2C (SDA=11, SCL=12)
│   ├── ElegantOTA/                         # Thư viện nạp firmware/LittleFS qua giao diện Web OTA (/update)
│   └── LCD/                                # Driver điều khiển màn hình LCD 16x2 qua I2C PCF8574 (địa chỉ 0x27)
├── ml/                                     # Pipeline huấn luyện mô hình TinyML
│   ├── dataset.csv                         # Tập dữ liệu cảm biến mô phỏng và ngẫu nhiên để huấn luyện
│   ├── dht_risk_model.tflite               # File mô hình TensorFlow Lite sau khi huấn luyện
│   ├── requirements.txt                    # Các thư viện Python phục vụ huấn luyện (numpy, tensorflow)
│   └── train_export.py                     # Script huấn luyện mô hình và xuất ra header C dht_anomaly_model.h
├── scripts/                                # Kịch bản công cụ bổ trợ
│   └── pull_wifi_info.py                   # Script Python đọc trực tiếp Flash ESP32 qua Serial trích xuất danh sách Wi-Fi
├── src/                                    # Source code C++ firmware ESP32
│   ├── global.cpp                          # Định nghĩa biến toàn cục và cờ đồng bộ
│   ├── led_blinky.cpp                      # Điều khiển LED GPIO48 theo rủi ro nhiệt độ; thời gian mỗi pha bật/tắt: Normal 1000ms, Warning 500ms, Critical 100ms
│   ├── main.cpp                            # setup() khởi tạo context, semaphore, 7 FreeRTOS tasks; loop() xử lý DNS, reconnect & OTA
│   ├── neo_blinky.cpp                      # Điều khiển màu sắc đèn NeoPixel GPIO45 theo độ ẩm không khí (Normal Xanh / Warning Vàng / Critical Đỏ)
│   ├── pump.cpp                            # Điều khiển bơm relay GPIO10: AUTO (bật <25%, tắt ≥32%, max 60s, cooldown 120s, khóa lỗi nếu 3 lần không tăng ≥3%), MANUAL (max 5 phút)
│   ├── serial_log.cpp                      # Định nghĩa hàm in log Serial có khóa Mutex tránh xung đột giữa các task FreeRTOS
│   ├── task_check_info.cpp                 # Quản lý LittleFS: lưu/đọc Wi-Fi (/info.dat, /wifi_list.json), lưu/đọc URL backend (/server.json), reset cấu hình
│   ├── task_database.cpp                   # Hàng đợi đệm (POST_QUEUE_MAX 6) gửi HTTPS POST /sensor với header X-Device-Key, WiFiClientSecure setInsecure, debounce 200ms
│   ├── task_handler.cpp                    # Xử lý sự kiện WebSocket: điều khiển GPIO thiết bị, lưu Wi-Fi & URL server từ client nhúng
│   ├── task_toogle_boot.cpp                # Kiểm tra thời gian nhấn giữ nút BOOT GPIO0 (>2 giây) để xóa file mạng và reboot về AP
│   ├── task_webserver.cpp                  # HTTP cổng 80, Basic Auth ở STA (bỏ qua ở AP), LittleFS, WebSocket/token, API Wi-Fi/URL backend/bơm và ElegantOTA /update
│   ├── task_wifi.cpp                       # Xử lý kết nối Wi-Fi, tự phục hồi mạng, phát AP (ESP32 LOCAL), Captive Portal và đồng bộ giờ NTP
│   ├── temp_humi_monitor.cpp               # Đọc cảm biến DHT20, ADC độ ẩm đất theo chu kỳ 5 giây, hiển thị LCD 16x2, kích hoạt semaphore cập nhật
│   └── tinyml.cpp                          # Suy luận TFLite Micro từ nhiệt độ/độ ẩm/đất, so sánh với rule, áp dụng ngưỡng an toàn và tính tỷ lệ khớp rule
├── .env                                    # Tạo cục bộ từ .env.example; biến môi trường thực tế: cấu hình PostgreSQL, Session Secret, SENSOR_API_KEY, ADMIN credentials, Cloudflare Token (gitignored)
├── .env.example                            # File mẫu khai báo biến môi trường cho Docker & Backend
├── .gitignore                              # Loại trừ .env, include/secrets.h, data/wifi_info.json, .pio, node_modules, môi trường Python và cache
├── docker-compose.yml                      # Ba container: PostgreSQL 16 (UTC+7, host 127.0.0.1:5433), backend (cổng nội bộ 3000), cloudflared; mạng iot_net và volume pgdata
├── HUONG_DAN_THUC_HIEN.md                  # Hướng dẫn chi tiết từng bước triển khai toàn bộ hệ thống Docker, Backend, Cloudflare & ESP32
├── platformio.ini                          # Cấu hình biên dịch PlatformIO (board yolo_uno, upload/monitor port, data_dir = FE, build_flags, lib_deps)
├── pyproject.toml                          # Cấu hình Pyright/Pylance cho Python; loại trừ .pio và lib, tùy chỉnh cảnh báo import
├── README.md                               # Tài liệu kiến trúc toàn diện của dự án
└── Struct.md                               # Sơ đồ cấu trúc cây thư mục chi tiết của dự án
```

Các thành phần và cách triển khai:

- **Firmware và giao diện thiết bị:** `src/`, `include/`, `lib/`, `boards/` và `platformio.ini` dùng cho ESP32. `FE/` là nguồn tạo ảnh LittleFS vì `data_dir = FE`; `data/` chứa kết quả trích xuất Wi-Fi, không phải thư mục nạp dashboard. Dashboard và WebSocket của thiết bị được phục vụ trực tiếp từ ESP32.
- **Backend và cơ sở dữ liệu:** `BE/` phục vụ API, đăng nhập và Web Admin; `DB/` chứa schema/migration. `docker-compose.yml` chạy PostgreSQL, backend và Cloudflare Tunnel. Hai script `DB.sql` và `auth_migration.sql` được mount vào thư mục khởi tạo PostgreSQL, chỉ chạy tự động khi khởi tạo volume dữ liệu mới. `timezone_migration.sql` không được mount để tự chạy: áp dụng thủ công một lần cho DB cũ, dừng backend và không chạy lại sau khi đã đổi kiểu cột.
- **Phân quyền thiết bị:** firmware gửi MAC trong `device_id` và địa chỉ mạng trong `lan_ip`. Backend tạo `card_key` theo MAC/IP và tự bổ sung `user_devices.lan_ip` cùng khóa chính ba cột. IP rỗng trong phân quyền cũ có nghĩa là cho phép mọi IP của MAC đó. Web Admin dùng `age_seconds` từ backend để tính trạng thái online/offline, với thời gian nhận bản ghi làm nguồn chính.
- **Cổng truy cập Internet:** `cloudflare-worker/` nằm trong cùng repository, dùng chung Git ở thư mục gốc và có bộ dependency riêng. Worker chuyển tiếp đường dẫn, query, phương thức và body đến backend qua VPC Service binding `IOT_BACKEND`. Cấu hình dịch vụ/tunnel trên Cloudflare cần khớp với môi trường triển khai; repository chỉ chứa tham chiếu service trong `wrangler.jsonc`.
- **Triển khai Worker riêng:** chạy `npm ci`, `npm run dev` hoặc `npm run deploy` bên trong `cloudflare-worker/`. Worker không phải container trong Docker Compose; push GitHub không tự triển khai Worker nếu chưa thiết lập CI/CD. Tên package `iot-env-monitor-public` được giữ nguyên sau khi chuyển thư mục. Bộ test hiện còn là mẫu “Hello World”, chưa xác nhận hành vi proxy.
- **Dữ liệu cục bộ:** `.pio/`, các thư mục `node_modules/`, `cloudflare-worker/.wrangler/`, môi trường Python/cache và các file bí mật được bỏ qua bởi `.gitignore` tương ứng. Dependency được khôi phục bằng PlatformIO hoặc `npm ci`; mật khẩu/token thực tế được cấu hình riêng trên máy hoặc môi trường triển khai.
