# TinyML điều khiển quạt trong phòng lab

Mô hình học đề xuất **OFF / HOLD / ON** từ nhiệt độ (°C) và độ ẩm không khí (%RH), chạy cục bộ trên ESP32. HOLD yêu cầu giữ trạng thái AUTO trước đó; không phải tốc độ quạt trung bình. Quạt/relay chỉ nhận ON/OFF. AI không dự báo nhiệt độ tương lai.

Trên giao diện thiết bị, mở **Settings → TinyML** để xem kết quả suy luận, xác suất, phiên bản mô hình và hướng dẫn thí nghiệm. Cấu hình ngưỡng, chọn chế độ và điều khiển quạt nằm riêng tại **Settings → Cấu hình FAN**; kết nối mạng nằm tại **Settings → Cấu hình WiFi**. Dashboard chính chỉ giữ các thông tin giám sát theo bố cục cũ.

Mô hình kèm theo được huấn luyện bằng dữ liệu **tổng hợp**, học lại chính sách `lab-or-30-28-75-70-v1`:

- ON khi `T >= 30` **hoặc** `RH >= 75`.
- OFF khi `T <= 28` **và** `RH <= 70`.
- HOLD trong các trường hợp còn lại.

Miền đã học là `5–50 °C`, `20–100 %RH`. Các ngưỡng chỉ định nghĩa bài thực hành; không phải tiêu chuẩn sức khỏe, thông gió hay bảo vệ thiết bị. Độ chính xác đo mức khớp với nhãn; luật giáo viên là baseline chính xác tuyệt đối trên nhãn tổng hợp. Mô hình học máy không có ưu thế về độ chính xác so với luật đó. Xác suất softmax chưa được hiệu chuẩn, không được gọi là xác suất quyết định đúng. Quạt tuần hoàn cũng không tự hút ẩm hoặc hạ nhiệt độ phòng kín.

Chế độ **AI** chỉ dùng đề xuất mô hình khi cấu hình quạt khớp đúng profile đã học: nhiệt độ bật/tắt `30/28 °C`, độ ẩm bật/tắt `75/70 %RH`, logic bật **OR** (`requireBoth=false`). Khi cấu hình khác, bộ điều khiển dùng luật theo cấu hình đã lưu và báo `ai_fallback_profile_mismatch`; đổi cấu hình không tự huấn luyện lại mô hình. Các điều kiện về mẫu đo mới/hợp lệ, miền đầu vào, trạng thái mô hình và ngưỡng softmax vẫn phải thỏa mãn. Chế độ **SHADOW** vẫn cho phép quan sát đề xuất AI với cấu hình khác, trong khi quạt thực thi luật cấu hình; mức khớp của mô hình luôn được tính với teacher cố định đã học.

## Kết quả bản mô hình bàn giao

Các số liệu sau thuộc `fan-policy-v1-bec2aad20791`, mô hình float32 4.788 byte; chi tiết nguồn dữ liệu, hash và confusion matrix nằm trong `models/fan_model_manifest.json`:

- Tổng cộng 36.000 mẫu tổng hợp: train 25.204, validation 5.398, test 5.398. Hai lần huấn luyện trên cùng môi trường đã tái tạo byte model và dataset giống nhau.
- Trên test: đúng 5.380/5.398 mẫu (**99,6665%**), **18 mẫu sai**; baseline luật teacher đúng 100% vì chính luật đó tạo nhãn.
- Với `max(softmax) >= 0.8`, test giữ 5.275/5.398 mẫu (**97,7214% độ phủ**), còn **1 mẫu sai** trong nhóm giữ lại (**99,9810% đúng có điều kiện**).
- Chẩn đoán 36 điểm tại/sát các ngưỡng: **10 điểm sai**; bộ lọc softmax giữ 18 điểm nhưng vẫn còn **5 điểm sai**. Sai số gần ngưỡng chưa được loại bỏ bằng bộ lọc.
- Chuyển đổi Keras → TFLite được đối chiếu trên toàn bộ 10.796 mẫu validation/test: không lệch lớp; sai số xác suất tuyệt đối tối đa khoảng `5,93 × 10^-6`.
- Runtime **TFLite Micro vendored chạy trên host** đã suy luận 10.836 mẫu (validation/test, 36 điểm sát ngưỡng và 4 góc miền), không lệch lớp so với desktop TFLite; sai số xác suất tối đa khoảng `7,87 × 10^-6`. Arena dùng 1.360/16.384 byte trên host 64 bit. Đây không phải số đo bộ nhớ hay thời gian thực trên ESP32.

Các kiểm tra này xác nhận quy trình dữ liệu và khả năng thực thi model trong phạm vi host. **Chưa xác nhận chạy trên phần cứng hoặc hiệu quả giảm nhiệt/ẩm thực tế**; không suy diễn mức khớp teacher thành bảo đảm đúng mọi lần điều khiển.

## Tái huấn luyện bộ mẫu

Dùng Python >= 3.12 với các phiên bản trong `requirements.txt`, trong môi trường ảo riêng:

```bash
python3.12 -m venv /tmp/iot-fan-ml
/tmp/iot-fan-ml/bin/python -m pip install -r ml/requirements.txt
/tmp/iot-fan-ml/bin/python ml/train_export.py --output-dir /tmp/iot-fan-candidate
```

Chạy từ gốc repository. `--output-dir` là gốc để xuất các nhánh `ml/` và `firmware/include/`; mặc định là repository hiện tại. Nên tạo candidate riêng rồi xem manifest trước khi thay mô hình đang dùng. `--seed 42 --epochs 100 --synthetic-samples 24000` là cấu hình mặc định; 12.000 mẫu gần ngưỡng được bổ sung trước khi loại trùng. Seed, phiên bản thư viện, cấu trúc, cách chia dữ liệu và hash được lưu trong manifest. Byte huấn luyện không được cam kết giống nhau giữa các nền tảng/phiên bản thư viện.

Pipeline chia mẫu tổng hợp duy nhất thành train/validation/test theo từng lớp, xấp xỉ 70/15/15. Validation chọn epoch theo loss; test không dùng huấn luyện hoặc chọn epoch. Mạng `2 → 32 → 16 → 3` được chuẩn hóa lúc huấn luyện rồi gộp phép chuẩn hóa vào lớp đầu: **firmware đưa vào giá trị °C và %RH gốc**. Pipeline kiểm tra schema, kích thước/dtype, chỉ cho FULLY_CONNECTED/SOFTMAX v1, đối chiếu mọi mẫu validation/test giữa Keras và TFLite, kiểm tra xác suất hữu hạn và tổng bằng 1, đồng thời báo riêng 36 điểm sát ngưỡng.

Các đầu ra đi cùng nhau:

- `ml/data/dataset.csv`: dữ liệu thực sự đưa vào huấn luyện, nhãn và phân vùng.
- `ml/models/dht_fan_model.tflite`: mô hình float32.
- `ml/models/fan_model_manifest.json`: nguồn dữ liệu, hash, confusion matrix, recall từng lớp, baseline, kiểm tra chuyển đổi và giới hạn xác nhận.
- `firmware/include/dht_fan_model.h`: byte mô hình `fan_model_tflite`, căn 16 byte.
- `firmware/include/fan_model_metadata.h`: phiên bản, hash, profile và miền đầu vào.

Không trộn model/header/metadata từ những lần xuất khác nhau. Sau khi thay mô hình phải build firmware, chạy thử thiết bị và đối chiếu Serial/telemetry. `hardware_validated=false` và `real_environment_efficacy_validated=false` trong manifest phản ánh phạm vi xác nhận, không phải lỗi pipeline.

Manifest báo cả độ phủ và số lỗi trong nhóm `max(softmax) >= 0.8`, riêng cho validation/test và 36 điểm sát ngưỡng. Đây chỉ là kiểm tra bộ lọc softmax; vẫn có thể tồn tại đề xuất sai dù qua ngưỡng 0.8. Không suy diễn độ chính xác có điều kiện thành bảo đảm đúng cho từng lần điều khiển.

`--model-version` đặt tên gốc tối đa 51 ký tự ASCII. Phiên bản được xuất luôn thêm 12 ký tự đầu SHA256 của byte mô hình, chẳng hạn `fan-policy-v1-bec2aad20791`, để phân biệt các lần huấn luyện khác nhau trên telemetry. Nếu đối số đã có hậu tố `-` và 12 ký tự hex thì hậu tố được thay bằng hash hiện tại; không nối lặp. Manifest giữ SHA256 đầy đủ để đối chiếu chính xác.

## Thu dữ liệu thật và gán nhãn

Xuất lịch sử thiết bị từ dashboard admin thành JSONL. Hoặc lưu các trang `/admin/api/history` thành JSON có `rows`. Công cụ chỉ đọc file cục bộ, không lưu thông tin đăng nhập:

```bash
python3 ml/import_history.py /tmp/history.jsonl --output /tmp/fan-unlabeled.csv
```

Có thể truyền nhiều file đầu vào. Mỗi mẫu được nhận dạng bằng `device_id + boot_id + sample_seq`; các bản tin sensor/fan/ai trùng mẫu được gộp, ưu tiên bản ghi có AI ready. Hai bản ghi cùng nhận dạng nhưng khác T/RH gây lỗi thay vì âm thầm chọn một. Bản ghi không có T/RH hữu hạn trong miền được bỏ qua và đếm rõ trong báo cáo. Bản ghi có T/RH nhưng thiếu nhận dạng phiên/mẫu gây lỗi vì không thể tách phiên đáng tin cậy. Phiên mặc định là `device_id:boot_id`, với từng thành phần được percent-encode để dấu hai chấm trong ID không gây trùng phiên.

Khi cơ sở dữ liệu chứa lịch sử trước bản nâng cấp, hãy lọc thời gian xuất từ lúc firmware mới bắt đầu gửi `boot_id/sample_seq`. Công cụ chủ động từ chối các dòng số đo cũ thiếu nhận dạng thay vì tự dựng phiên giả. Bản ghi `status=ready` chỉ được ưu tiên nếu `ai.sample_seq` khớp mẫu đang gộp.

Báo cáo importer đếm khoảng trống `sample_seq` giữa ID đầu/cuối còn giữ của mỗi phiên. Đây là số ID thiếu trong phạm vi quan sát, không khẳng định mất do mạng hay chứng minh dữ liệu đầy đủ: bộ lọc, giới hạn xuất và hàng đợi telemetry đều có thể làm thiếu mẫu. Công cụ không nội suy. Các khoảng trống phải được giữ riêng khi xây dựng cửa sổ dự báo tương lai; không nối qua chúng như chuỗi đo liên tục. CSV giữ `device_id`, `boot_id`, `sample_seq` và thời điểm lấy mẫu để kiểm tra lại.

CSV xuất mặc định có `label` trống và `label_source=unlabeled`. Người gán nhãn cần điền **OFF, HOLD hoặc ON** theo quy trình đã định và đổi `label_source` thành **operator**; giữ `session_id`. Không dùng dự đoán AI làm nhãn. `fan_state` là trạng thái relay được báo khi phát bản tin, có thể thuộc quyết định từ mẫu trước; chưa phải số đo quạt quay hoặc hiệu quả làm mát. Các cột `fan_decision_sample_seq` và `fan_decided_uptime_ms` giữ lại ngữ cảnh quyết định nếu bản tin có cung cấp. Những cột phụ không tự biến thành đặc trưng đầu vào hay nhãn mục tiêu.

```bash
/tmp/iot-fan-ml/bin/python ml/train_export.py \
  --csv /tmp/fan-labeled.csv --label-source operator \
  --model-version fan-operator-v1 --output-dir /tmp/fan-operator-candidate
```

Dữ liệu CSV cần ít nhất 30 mẫu, ít nhất ba phiên độc lập và đủ ba lớp trong mỗi phần train/validation/test. Pipeline chia nguyên phiên theo seed, không chia ngẫu nhiên từng dòng thời gian. Nếu nhiều lần boot vẫn thuộc cùng một phiên thí nghiệm liên tục, người chuẩn bị dữ liệu phải gộp chúng về cùng `session_id` trước khi huấn luyện để tránh rò rỉ ngữ cảnh. Nhãn operator chỉ chứng minh khả năng bắt chước lựa chọn người gán, chưa chứng minh tối ưu điện năng/vi khí hậu.

Để thử quy trình bằng số đo thật nhưng nhãn do luật tạo, phải khai báo rõ:

```bash
python3 ml/import_history.py /tmp/history.jsonl \
  --label-source synthetic-policy --output /tmp/fan-policy-labeled.csv
/tmp/iot-fan-ml/bin/python ml/train_export.py \
  --csv /tmp/fan-policy-labeled.csv --label-source synthetic-policy \
  --model-version fan-recorded-policy-v1 --output-dir /tmp/fan-recorded-candidate
```

Pipeline kiểm tra mọi nhãn `synthetic-policy` đúng với luật. Nguồn mẫu là recorded-csv nhưng nguồn nhãn vẫn synthetic-policy; không trình bày chúng là kết quả hiệu quả thực nghiệm. File output importer đã tồn tại bị từ chối để bảo toàn công gán nhãn.

## Đánh giá tiếp theo

Quan sát SHADOW trước khi bật AI; kiểm tra tình huống gần ngưỡng, cảm biến lỗi/cũ, ngoài miền, khởi động lại và chế độ MANUAL. So sánh luật với AI trên các phiên thử giữ riêng. Đo số lần bật/tắt sai, thời gian phản ứng, số lần đóng relay và thời lượng quạt chạy; chỉ kết luận giảm nhiệt/ẩm nếu bố trí thí nghiệm có đối chứng và số đo chứng minh. Dự báo 1–5 phút là bước tiếp theo cần lịch sử T/RH/quạt, thiết kế nhãn tương lai và chia phiên/thời gian; phiên bản hiện tại chưa triển khai dự báo.
