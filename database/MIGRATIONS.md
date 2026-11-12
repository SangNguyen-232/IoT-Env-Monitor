# Nâng cấp dữ liệu AI mà giữ lịch sử

Docker chỉ chạy các file `/docker-entrypoint-initdb.d` khi khởi tạo volume rỗng.
Rebuild backend không tự áp dụng migration cho volume đã có dữ liệu.
Không dùng `docker compose down -v` để nâng cấp vì lệnh đó xóa volume dữ liệu.

## Cơ sở dữ liệu đang có

Thực hiện từ thư mục gốc dự án, sau khi kiểm tra đúng dịch vụ PostgreSQL và bản sao lưu.
Các lệnh bên dưới dùng tài khoản đã cấu hình trong container, không yêu cầu chép mật khẩu vào dòng lệnh.

```bash
# Dừng tác vụ ghi và retention của backend trong lúc sao lưu/nâng cấp.
docker compose stop backend
backup_dir=$(mktemp -d /tmp/iot-ai-backup.XXXXXX)
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_dir/before-ai.dump"
# Xác nhận file sao lưu đọc được; hãy sao chép ra nơi lưu trữ bền vững riêng.
docker compose exec -T postgres pg_restore --list < "$backup_dir/before-ai.dump"
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < database/migrations/005_ai_telemetry.sql
docker compose up -d --build backend
docker compose logs --tail=80 backend
```

Các migration `001`–`004` thuộc nền tảng hiện có. Nếu nâng cấp từ phiên bản cũ hơn nữa,
kiểm tra schema và hướng dẫn trong từng migration trước khi áp dụng theo thứ tự.
Migration `002` chuyển timestamp cũ dựa trên múi giờ nguồn; không tự đoán múi giờ của dữ liệu ngoài dự án.
Migration `005` có transaction, thêm cột nullable và index, không viết lại nhãn cho lịch sử.
Có thể chạy lại `005`; nếu hết thời gian chờ lock thì transaction rollback và cần chạy lại khi hết tác vụ đang khóa bảng.
Việc tạo index/kiểm tra constraint có thể mất thời gian trên bảng lớn.
Backend kiểm tra đủ cột lúc khởi động và dừng với hướng dẫn migration nếu còn thiếu.
Rollback phần mềm về backend cũ có thể giữ các cột mới; firmware mới cần backend mới để gửi các trường AI.

## Cơ sở dữ liệu mới

`docker compose up -d --build` sử dụng `base.sql` cùng các script auth, session, display và AI đã mount.
Trình tự này chỉ dành cho khởi tạo mới, không thay cho quy trình nâng cấp volume ở trên.

## Dữ liệu thí nghiệm và API lịch sử

- `Score` được giữ cho bản ghi cũ; firmware mới gửi `null`. `ai.agreement_pct` đo mức khớp với luật, không phải hiệu quả làm mát hay độ tin cậy đã hiệu chuẩn.
- `ai` lưu phiên bản mô hình, trạng thái, dự đoán `OFF/HOLD/ON`, xác suất theo đúng thứ tự đó, thời gian suy luận, nhãn luật và số mẫu được đối chiếu. Metadata sai kiểu, ngoài giới hạn hoặc chứa khóa không hỗ trợ bị từ chối.
- Khi `ai.status=ready`, `sample_seq` và `sampled_uptime_ms` ở cấp ngoài phải có mặt và trùng với hai giá trị bên trong `ai`. Trạng thái không sẵn sàng có thể giữ ID của mẫu suy luận trước nhưng không giữ dự đoán/xác suất cũ như kết quả sẵn sàng.
- `boot_id` và `sample_seq` định danh mẫu trong mỗi lần khởi động. `sampled_uptime_ms` là thời điểm lấy mẫu theo `millis()` 32 bit; nó tràn sau khoảng 49,7 ngày. Nhiều sự kiện `sensor`, `fan`, `ai` có thể cùng tham chiếu một mẫu.
- `received_at` là lúc backend nhận; `timestamp_up` là thời gian tải lên từ thiết bị; không dùng các cột này làm nhãn thời điểm lấy mẫu khi xử lý lịch sử offline.
- `fan_reason` giải thích quyết định; `fan_config` lưu bản sao cấu hình ngưỡng mà bộ điều khiển đã dùng cho quyết định được ghi, kể cả khi dashboard vừa lưu cấu hình mới đang chờ chu kỳ tiếp theo. `MODE_state` nhận `AUTO`, `SHADOW`, `AI`, `MANUAL`.
- `fan_decision_sample_seq` chỉ mẫu mà bộ điều khiển dùng trong lần cập nhật lệnh quạt gần nhất; `fan_decided_uptime_ms` chỉ thời điểm cập nhật theo `millis()` 32 bit. Ảnh chụp cảm biến/AI và trạng thái quạt được lấy qua hai khóa riêng, nên mẫu điều khiển có thể khác `sample_seq` của bản ghi. Đây là dấu vết lệnh phần mềm, chưa phải xác nhận quạt vật lý đang quay hoặc đo hiệu quả làm mát. Các bản ghi cũ để `null`.
- Thu thập telemetry là best effort: cờ sự kiện có thể gộp nhiều lần cập nhật khi gửi HTTP chậm; hàng đợi tối đa sáu payload loại bản cũ nhất khi đầy. Không bảo đảm lưu mọi mẫu suy luận hay mọi chuyển trạng thái quạt. Khi xây dựng cửa sổ dự báo, kiểm tra `boot_id`, số thứ tự và thời gian mẫu để loại cửa sổ thiếu dữ liệu; không suy diễn thời gian tác động từ thứ tự bản ghi nhận ở server.
- `SENSOR_RETENTION_DAYS` mặc định `30`, xóa khi khởi động và mỗi sáu giờ. Đặt `0` để tắt tự xóa trong phiên thu lab dài; theo dõi dung lượng và sao lưu/xuất dữ liệu chủ động. Thay đổi retention không khôi phục dữ liệu đã bị xóa.

Endpoint đã đăng nhập: `GET /admin/api/history?device_id=DEVICE&limit=1000`.
Có thể thêm `lan_ip`, `from` (bao gồm), `to` (không bao gồm); thời gian cần ISO 8601 có `Z` hoặc offset,
ví dụ `2026-11-11T08:00:00%2B07:00`. Bộ lọc thời gian áp dụng `received_at`, fallback `timestamp_up` cho dữ liệu cũ.
`limit` từ 1 đến 1000, mặc định 500. Kết quả `{rows, next_after_id, until_id}` có `rows` tăng dần theo `id`.
Nếu `next_after_id` khác `null`, giữ nguyên bộ lọc và gửi trang sau với
`after_id=next_after_id&until_id=until_id`. `next_after_id=null` kết thúc xuất.
`until_id` là mốc ID trên để dữ liệu mới thông thường không kéo dài vòng xuất;
đây không phải snapshot bất biến: xóa/retention hoặc transaction cũ commit muộn có thể thay đổi dữ liệu nhìn thấy.
Muốn bộ dữ liệu lưu trữ ổn định tuyệt đối, thu xong rồi dừng ghi/xóa và xuất hoặc dùng bản sao lưu PostgreSQL.
Quyền xem được kiểm tra lại trên từng dòng theo tài khoản, `device_id` và `lan_ip`; người dùng thường chỉ xuất được các thiết bị/IP được cấp.
Các trường metadata vắng trong firmware cũ được lưu `null`; không tự biến bản ghi cũ thành mẫu AI.
