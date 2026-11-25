# Rà soát và kiểm thử TinyML dự báo xu hướng trên ESP32-S3

**Câu hỏi cần kiểm chứng:** khi hai chuỗi DHT20 cùng kết thúc ở 28,5°C / 71% RH, bộ điều khiển có phân biệt được độ ẩm đang tăng với đang giảm, bật quạt sớm ở chuỗi tăng và vẫn xử lý đúng mất cảm biến không?

Nếu đây là lần đầu chạy, thực hiện **bước 1–5** trên máy. Bạn sẽ có log của đúng bộ suy luận trong firmware, kết quả trên 3.600 cửa sổ và hai image cho ESP32-S3. **Bước 6** dành cho kiểm tra bằng TensorFlow, dữ liệu huấn luyện và khả năng tái lập. **Bước 7–8** dành cho buổi thử có board đã nạp đúng bản. **Bước 9** dùng khi có lịch sử thực để chấm dự báo. **Bước 10** tổng hợp bằng chứng cho báo cáo. Các lệnh dưới đây dùng Bash trên Linux.

[Chạy replay](#replay) · [Chấm tập test](#tap-test) · [Tái huấn luyện](#kiem-ml) · [Sáu ca HIL](#hil) · [Chấm phiên thật](#lich-su) · [Mẫu biên bản](#ket-luan)

<a id="chuan-bi"></a>

## Bước 1 · Mở đúng dự án và tạo thư mục lưu kết quả

Mở Terminal, chạy cả khối sau. Giữ nguyên cửa sổ Terminal để các bước sau dùng chung biến `ROOT` và `RUN`. Mỗi lần kiểm thử có một thư mục mới.

```bash
cd /home/sang/Desktop/IoT-Env-Monitor
ROOT=$(pwd -P)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/fan-audit.XXXXXXXX")
export ROOT RUN
export PYTHONDONTWRITEBYTECODE=1
set -o pipefail
printf 'Repo: %s\nKết quả: %s\n' "$ROOT" "$RUN"
git rev-parse HEAD > "$RUN/commit.txt"
git status --short --branch > "$RUN/worktree.txt"
cmake --version | head -n 1
c++ --version | head -n 1
python3 --version
```

**Đạt** khi thấy đúng đường dẫn dự án, thư mục lưu kết quả, CMake ≥ 3.16, một trình biên dịch hỗ trợ C++20 và Python ≥ 3.10. Python 3.10/3.11 đủ cho bước 1–5. Nếu thiếu CMake hoặc compiler trên Ubuntu, có thể cài bằng `sudo apt install cmake build-essential`. Các dòng `M` hoặc `??` trong `worktree.txt` ghi nhận mã nguồn thực tế đang được thử. Lệnh `set -o pipefail` giúp phát hiện lỗi của chương trình ngay cả khi xuất kết quả qua `tee`. Nếu một lệnh báo lỗi, xử lý tại bước đó trước khi đọc log tiếp theo. Khi dùng Terminal mới, đặt lại `ROOT`, `RUN` theo đúng hai đường dẫn đã in và chạy `cd "$ROOT"`.

<a id="doi-chieu"></a>

## Bước 2 · Đối chiếu thuật toán, đơn vị và model đã đóng gói

**2.1. Lần theo một mẫu.** Đọc các vị trí sau theo thứ tự. Ví dụ cần theo dõi là quạt đang OFF, T = 28,5°C, RH = 71%, độ ẩm đã tăng từ 63,8% lên 71% trong 30 giây.

1. Task DHT20 lấy T, RH, mã mẫu, thời điểm và lệnh GPIO đang áp dụng ngay khi đọc. Đất là kênh giám sát độc lập. [Lấy mẫu DHT20](../firmware/src/environment_monitor.cpp)
2. Cửa sổ giữ **7 mẫu**. Sáu khoảng cách 5 giây tạo lịch sử **30 giây**. Kiểm tra thứ tự 8 đầu vào: T hiện tại, RH hiện tại, hai độ dốc hồi quy toàn cửa sổ, hai độ dốc của bước cuối, độ dao động quanh hai đường hồi quy, lệnh GPIO khi lấy mẫu. Độ dốc dùng thời gian lấy mẫu thực. Mất số thứ tự, hai mẫu cùng thời điểm hoặc cách nhau hơn 8 giây làm cửa sổ tích lũy lại. [Trích đặc trưng C++](../firmware/include/temporal_window.h) · [Đối chiếu Python](trend_features.py)
3. Kiểm tra schema, kiểu tensor, kích thước vào `[1,8]`, ra `[1,3]` và hai phép toán `FULLY_CONNECTED`, `SOFTMAX`. Firmware tính đặc trưng bằng số thực, lượng tử hóa đầu vào, chạy mạng INT8 rồi giải lượng tử ba điểm **OFF, HOLD, ON**. Mỗi điểm tăng theo bội số 1/256. [Bộ suy luận Micro](../firmware/include/fan_inference.h) · [Metadata đã xuất](../firmware/include/fan_model_metadata.h)
4. Mục tiêu học là vùng ngưỡng tại **t + 30 giây**, với giả định lệnh quạt ở t tiếp tục được giữ. Vùng ON khi T ≥ 30°C hoặc RH ≥ 75%, vùng OFF khi T ≤ 28°C và RH ≤ 70%, còn lại HOLD. Với 28,5°C / 71%, vùng **hiện tại** là HOLD. Dự báo ON vẫn có thể đúng nếu 30 giây sau thuộc vùng ON. [Tạo nhãn và huấn luyện](train_export.py)
5. Kiểm tra ai được quyền điều khiển relay. Trong SHADOW, ngưỡng người dùng quyết định GPIO. Trong AI, bộ giám sát kiểm tra cấu hình OR 30/28°C và 75/70% RH, mẫu còn mới, kết quả suy luận khớp số mẫu và thời điểm lấy mẫu, T/RH trong miền, trạng thái `ready` và điểm cao nhất ≥ 0,80. Trong dải trễ có thể bật sớm. Khi quạt đang ON, lệnh OFF của model trong dải trễ vẫn phải qua bộ giám sát. Mẫu DHT lỗi có quyền ngắt ngay trong các mode tự động. [Trạng thái model](../firmware/include/fan_predictor.h) · [Bộ giám sát và thời gian giữ relay](../firmware/include/fan_policy.h)

**2.2. Kiểm tra phiên bản.** Từ thư mục gốc, đối chiếu ba bản đại diện của model và danh tính dataset. Đoạn này chỉ cần thư viện chuẩn Python.

```bash
python3 - <<'PY' | tee "$RUN/artifacts.txt"
import hashlib, json, re
from pathlib import Path
manifest = json.loads(Path("ml/models/fan_model_manifest.json").read_text())
model = Path("ml/models/dht_fan_model.tflite").read_bytes()
header = Path("firmware/include/dht_fan_model.h").read_text()
meta = Path("firmware/include/fan_model_metadata.h").read_text()
embedded = bytes(int(v, 16) for v in re.findall(r"0x([0-9a-fA-F]{2})\b", header))
digest = hashlib.sha256(model).hexdigest()
assert embedded == model and len(model) == manifest["bytes"], "Model trong header khac file TFLite"
assert digest == manifest["sha256"] and digest in meta, "Sai SHA-256 model"
assert manifest["model_version"] in meta, "Sai phien ban trong metadata"
assert hashlib.sha256(Path("ml/data/dataset.csv").read_bytes()).hexdigest() == manifest["dataset"]["sha256"], "Sai dataset"
print(manifest["model_version"], len(model), "bytes", digest)
print("PASS")
PY
```

**Mốc của bản này:** `fan-trend-int8-v2-8abd0b91c744`, 5.536 byte, SHA-256 `8abd0b91c74416bfaf274f6531e3ff7388200be4fc1ca1621dff048aa3f182cc`. Nếu sai, kiểm tra xem model, hai header, manifest và dataset có cùng lần export. Giữ kết quả riêng nếu đang đánh giá một model vừa huấn luyện lại.

<a id="replay"></a>

## Bước 3 · Chạy một thí nghiệm từ cảm biến giả lập đến quyết định relay

**3.1. Build và chạy.** Đây là chương trình C++ trên máy, liên kết thư viện TensorFlow Lite Micro đi kèm dự án. Replay cấp các mẫu đã định sẵn cho cùng lớp trích đặc trưng, model và chính sách mà firmware sử dụng.

```bash
cmake -S tools/replay -B "$RUN/build" -DCMAKE_BUILD_TYPE=Release 2>&1 | tee "$RUN/cmake.log"
cmake --build "$RUN/build" --parallel 2 2>&1 | tee "$RUN/build.log"
"$RUN/build/fan_replay" 2>&1 | tee "$RUN/replay.txt"
```

**3.2. Đọc kết quả từ trái qua phải.** Sau tên phép thử là thời điểm mô phỏng theo ms, T, RH, độ dốc RH theo **điểm phần trăm/phút**, đề xuất model, bộ ba điểm, lệnh quạt và lý do. Cột lệnh quạt biểu diễn kết quả logic trong replay. Để đối chiếu từng pha, tìm các dòng sau trong `replay.txt`:

1. `rising / AI` tại 35.000 ms: 28,5°C / 71%, dRH = +14,4/phút, đề xuất ON khoảng 0,996, lệnh ON với `ai_proactive_on`. Mẫu thứ nhất của replay ở 5.000 ms, nên mẫu thứ bảy ở 35.000 ms.
2. `falling / AI` cũng tại 35.000 ms: cùng T/RH cuối, dRH = −7,2/phút, đề xuất OFF khoảng 0,961, lệnh OFF với `ai_off`. `rising / AUTO` dùng chính chuỗi tăng, vẫn hiện đề xuất ON nhưng GPIO logic OFF với `rule_off`.
3. `AUTO crossing` ở 55.000 ms, RH = 75,8%, luật ra ON. Chênh lệch 55.000 − 35.000 = **20 giây bật sớm trên chuỗi này**. Dòng `RH rise / fixed T` thử lại với T luôn là 28,5°C để cô lập tác động của xu hướng độ ẩm.
4. `SHADOW / custom` dùng bộ ngưỡng 35/32°C, 85/80% RH. Ở 77% RH, AI đề xuất ON nhưng lệnh OFF với `rule_off`. Dòng `AI / custom` đổi sang AI và trả `ai_fallback_profile_mismatch`.
5. `low score` dùng bảy lần 27°C / 74,8%, bắt đầu OFF. Hai điểm HOLD và ON xấp xỉ 0,523 và 0,477. Dù model sẵn sàng, điểm lớn nhất < 0,80, lệnh OFF với `ai_fallback_low_score`.
6. `cool at +5s` giữ ON với `min_on_time`. Replay còn kiểm tra ở +9.999 ms. Đến `cool at +10s`, cả hai giá trị đều thấp, quyết định chuyển OFF. `sensor unplug` xuất một mẫu lỗi khi quạt đang ON, lệnh về OFF với `sensor_invalid` mà không đợi đủ 10 giây.

**3.3. Kiểm tra các nhánh chỉ có assertion.** Chương trình in `PASS` sau khi cả các kiểm tra sau đã chạy: chưa cấu hình → `config_required`; nhận lại mẫu tốt sau lỗi → `ai_fallback_warming_up`; đề xuất sai mã mẫu → `ai_fallback_stale`; đưa trạng thái model lỗi hoặc điểm NaN vào bộ điều khiển → dự phòng; 51°C / 60% RH là dữ liệu DHT hợp lệ nhưng ngoài miền model → luật dự phòng có thể bật quạt; mẫu quá 15.000 ms → OFF. Replay còn tiêm đề xuất mâu thuẫn để thử ba nhánh `ai_guard_*`, thử thời gian giữ OFF khi đổi mode trùng lúc mất mẫu và thử bộ đếm `millis()`/thứ tự mẫu quay vòng. Đây là kiểm tra logic C++. HTTP 409 và thời gian ngắt relay vật lý có phép thử riêng ở bước 8. [Các hàm kiểm thử và điều kiện PASS](../tools/replay/fan_replay.cpp)

**3.4. Tự thay đổi riêng xu hướng độ ẩm (tùy chọn).** Dùng hai cửa sổ lý tưởng có cùng T/RH cuối 28,5°C / 71%, quạt OFF. Ở hàng thứ nhất mọi độ dốc bằng 0. Ở hàng thứ hai, chỉ RH tăng đều 14,4 điểm phần trăm/phút. Giá trị RH đã chuẩn hóa là `(71−70)/5/4 = 0,05`. Hai tốc độ RH đều là `14,4/5/4 = 0,72`. Độ dao động quanh đường thẳng bằng 0.

```bash
"$RUN/build/fan_replay" --score-windows <<'SAMPLES' | tee "$RUN/two-windows.txt"
0.0625 0.05 0 0    0 0    0 0
0.0625 0.05 0 0.72 0 0.72 0 0
SAMPLES
```

Với model đi kèm, hai dòng kết quả là `0 255 0` (HOLD) và `0 1 255` (ON). Dòng đầu tiên của đầu ra là phiên bản model. Mỗi dòng tiếp theo có ba số nguyên, chia từng số cho 256 để lấy điểm OFF/HOLD/ON. Chế độ này nhận **8 đặc trưng đã chuẩn hóa**, chỉ chấm model. Dùng replay mặc định ở 3.1 để kiểm tra cả thời gian, bộ giám sát và lệnh quạt. Trên host x86-64 đã kiểm tra, dòng đầu của replay báo ring 92 byte và arena đã dùng 1.520 byte trong vùng 4 KiB dành sẵn. Đối chiếu con số trên ESP32 bằng log khởi động khi chạy HIL.

<a id="tap-test"></a>

## Bước 4 · Chấm toàn bộ tập test và đọc đúng mẫu số

```bash
python3 -B tools/replay/evaluate.py "$RUN/build/fan_replay" | tee "$RUN/evaluation.json"
```

**Đạt với bản đi kèm** khi file JSON ghi đúng phiên bản, `label_source=simulated-future` và các số sau:

- `held_out_windows=3600`, `micro_correct=3151`: **87,53%** dự báo đúng lớp tại +30 giây trên toàn bộ tập test tổng hợp.
- `static_correct=2557` (**71,03%**) dùng lớp hiện tại để đoán tương lai. `ols_correct=2986` (**82,94%**) kéo dài đường xu hướng tuyến tính thêm 30 giây. Cả ba dùng cùng tập test và cùng nhãn tương lai.
- `gate_accepted=2771`, `gate_accepted_correct=2632`: **76,97%** số cửa sổ đạt cổng điểm; **94,98%** dự báo đúng trong nhóm đạt cổng. Đại lượng thứ hai chỉ mô tả những cửa sổ đã được chấp nhận.
- `early_on_before_dwell`: 91 dương tính đúng, 12 báo động giả và 54 bỏ lỡ trong nhóm đang ở vùng HOLD, quạt ban đầu OFF. Precision = 91/(91+12) = **88,35%**, recall = 91/(91+54) = **62,76%**. Mỗi cửa sổ được chấm độc lập, chưa áp dụng lịch sử giữ relay.

`agreement_pct` trên dashboard so đề xuất với luật **ở hiện tại**. Bật sớm đúng lúc có thể làm chỉ số này giảm. Khi báo cáo, ghi rõ bộ suy luận Micro trên host, dữ liệu tổng hợp và thời điểm nhãn là +30 giây. Nếu bộ chấm báo `Dataset digest differs` hoặc `Rebuild the executable`, quay lại bước 2 rồi build bằng đúng checkout.

<a id="build"></a>

## Bước 5 · Build firmware và LittleFS, đối chiếu nội dung image

**5.1.** Các lệnh sau hoạt động cả khi ngắt cáp USB. Kiểm tra PlatformIO và header cấu hình. Nếu bản checkout mới chưa có `secrets.h`, làm phần cấu hình firmware tại [hướng dẫn dự án](../GUIDE.md), giữ riêng các giá trị đăng nhập.

```bash
PIO=$(command -v pio || printf '%s' "$HOME/.platformio/penv/bin/pio")
"$PIO" --version
test -f firmware/include/secrets.h && echo "Da co secrets.h"
"$PIO" run -e yolo_uno 2>&1 | tee "$RUN/firmware.log"
"$PIO" run -e yolo_uno -t buildfs 2>&1 | tee "$RUN/littlefs.log"
```

**5.2.** Tìm `[SUCCESS]` trong cả hai log. Đọc mức RAM/flash ở cuối log firmware. Với bản tham chiếu, PlatformIO báo RAM tĩnh 52.236/327.680 byte và flash 1.150.677/3.342.336 byte. Nếu mã ngoài phần AI hoặc toolchain đã thay đổi, đối chiếu lại cấu hình build. Đây là mức dùng lúc liên kết; thời gian suy luận trên ESP32 phải đọc từ chính board.

```bash
python3 - <<'PY' | tee "$RUN/image-check.txt"
from pathlib import Path
import json
image = Path(".pio/build/yolo_uno/firmware.bin").read_bytes()
filesystem = Path(".pio/build/yolo_uno/littlefs.bin")
model = Path("ml/models/dht_fan_model.tflite").read_bytes()
version = json.loads(Path("ml/models/fan_model_manifest.json").read_text())["model_version"]
assert image.count(model) == 1 and version.encode() in image, "Firmware khong chua dung model"
assert filesystem.stat().st_size > 0, "Thieu image giao dien"
print(version, "PASS firmware.bin", len(image), "bytes | littlefs.bin", filesystem.stat().st_size, "bytes")
PY
```

Nếu cần kiểm tra từng byte của giao diện đóng gói, chạy thêm trên máy Linux đã cài gói `tool-mklittlefs` của PlatformIO:

```bash
FS=.pio/build/yolo_uno/littlefs.bin
FS_TOOL="$HOME/.platformio/packages/tool-mklittlefs/mklittlefs"
mkdir -p "$RUN/unpacked"
"$FS_TOOL" -u "$RUN/unpacked" -s "$(stat -c %s "$FS")" -b 4096 -p 256 "$FS"
diff -qr firmware/data "$RUN/unpacked"
```

`diff` trả mã 0, không in khác biệt khi các file trong image khớp bản nguồn. Hai mục tiêu `run` và `buildfs` ở trên chỉ tạo file trong `.pio/build/yolo_uno/`. Đến đây bạn đã kiểm chứng bản build cho ESP32-S3 và nội dung của hai image.

<a id="kiem-ml"></a>

## Bước 6 · Kiểm tra mô hình desktop và tái huấn luyện (tùy chọn)

### 6.1. Chọn Python cho phần ML

Tiếp tục trong Bash đã có `ROOT` là đường dẫn đến kho mã và `RUN` là thư mục bằng chứng riêng của lần kiểm thử. Để chạy bước 9, chỉ cần hoàn thành mục 6.1 cho bộ nhập lịch sử. Môi trường ghi trong manifest dùng Python 3.12.16, NumPy 2.5.4, TensorFlow CPU 2.21.0 và Keras 3.15.1. Khối sau tìm môi trường phù hợp, kể cả đường dẫn `ML_PY` bạn đã chọn trước. Nếu cần cài, nó tạo môi trường trong `$RUN`. Bước cài cần truy cập kho gói hoặc các gói đã được cache.

```bash
: "${ROOT:?}" "${RUN:?}"
cd "$ROOT"
set -o pipefail
export PYTHONDONTWRITEBYTECODE=1 TF_CPP_MIN_LOG_LEVEL=2
export OPENBLAS_NUM_THREADS=1 TF_ENABLE_ONEDNN_OPTS=0 CUDA_VISIBLE_DEVICES=-1
py_candidates=("${ML_PY:-}" "${VIRTUAL_ENV:+$VIRTUAL_ENV/bin/python}" "$ROOT/.venv/bin/python"
               "${CONDA_PREFIX:+$CONDA_PREFIX/bin/python}" "$(command -v python3.12 || true)" "$(command -v python3 || true)")
ML_PY=""
for py in "${py_candidates[@]}"; do
  [ -x "$py" ] || continue
  if "$py" -c 'import sys, importlib.metadata as m
assert sys.version_info[:2] == (3, 12)
assert [m.version(p) for p in ("numpy","tensorflow-cpu","keras")] == ["2.5.4","2.21.0","3.15.1"]' 2>/dev/null; then
    ML_PY="$py"
    break
  fi
done

tao_moi_truong_ml() {
  if command -v python3.12 >/dev/null; then
    python3.12 -m venv "$RUN/ml-env" || return 1
  elif command -v conda >/dev/null; then
    conda create -y -p "$RUN/ml-env" python=3.12.16 pip || return 1
  else
    echo "Cần Python 3.12 có venv hoặc Conda để tạo môi trường ML." >&2
    return 1
  fi
  "$RUN/ml-env/bin/python" -m pip install -r "$ROOT/ml/requirements.txt" || return 1
  ML_PY="$RUN/ml-env/bin/python"
}
[ -n "$ML_PY" ] || tao_moi_truong_ml
export ML_PY
[ -n "$ML_PY" ] && "$ML_PY" -c 'import sys, numpy, tensorflow as tf, keras
print(sys.executable, sys.version, numpy.__version__, tf.__version__, keras.__version__, sep="\n")' \
  | tee "$RUN/ml-environment.txt"
```

Chỉ tiếp tục sau khi dòng lệnh cuối in đủ bốn phiên bản và đường dẫn Python. Nếu cả `python3.12` lẫn Conda đều vắng, có thể chạy phần replay C++ ngay và bổ sung môi trường ML cho các bước dưới.

### 6.2. Chạy mô hình desktop đã đóng gói

```bash
"$ML_PY" "$ROOT/ml/replay.py" --model "$ROOT/ml/models/dht_fan_model.tflite" \
  > "$RUN/ml-desktop-windows.json" 2> "$RUN/ml-desktop-windows.stderr"
"$ML_PY" - "$RUN/ml-desktop-windows.json" <<'PY'
import json, sys
for name, r in json.load(open(sys.argv[1])).items():
    print(name, r["temperature_c"][-1], r["humidity_percent"][-1], r["static_rule"],
          r["proposal"], [round(s*256) for s in r["scores_off_hold_on"]])
PY
```

Ba dòng đầu cùng kết thúc ở 28,5°C / 71% RH. Với quạt ban đầu OFF, AUTO giữ OFF vì mẫu cuối thuộc vùng HOLD. TFLite desktop cho chuỗi tăng ON với điểm 255/256, chuỗi giảm OFF với 246/256 và chuỗi đứng yên HOLD với 255/256. Dòng `low_score` dùng bảy mẫu 27,0°C / 74,8% RH, cho điểm cao nhất 141/256. Điểm này thấp hơn 0,80 nên ở chế độ AI, bộ giám sát dùng luật dự phòng. File JSON có đủ bảy giá trị mỗi kênh và điểm theo thứ tự OFF, HOLD, ON.

### 6.3. Đối chiếu nhãn, phiên và điểm số trên toàn bộ tập test

Mỗi dòng của bộ đóng gói tương ứng một kịch bản tổng hợp độc lập. Nhãn ON khi T ở giây +30 ≥ 30°C hoặc RH ≥ 75%, OFF khi T ≤ 28°C và RH ≤ 70%, HOLD cho phần còn lại. Hai cột `future_*` là kết quả tương lai để chấm điểm. Kiểm tra dưới đây đọc đủ 24.000 dòng, kiểm tra định danh tập dữ liệu, tính lại nhãn, kiểm tra các tập phiên rời nhau và chấm lại 3.600 dòng test bằng flatbuffer đã xuất.

```bash
"$ML_PY" - "$ROOT" <<'PY' | tee "$RUN/ml-desktop-test.txt"
import csv, hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root / "ml"))
import numpy as np
import tensorflow as tf
from trend_features import LABELS, FEATURE_NAMES, band_label, scale_features
from replay import invoke_int8_tflite
ml = root / "ml"
m = json.loads((ml / "models/fan_model_manifest.json").read_text())
model = (ml / "models/dht_fan_model.tflite").read_bytes()
dataset = ml / "data/dataset.csv"
assert hashlib.sha256(model).hexdigest() == m["sha256"]
assert hashlib.sha256(dataset.read_bytes()).hexdigest() == m["dataset"]["sha256"]
assert list(FEATURE_NAMES) == m["window"]["features"] and len(FEATURE_NAMES) == 8
assert not any(k.startswith("future_") for k in FEATURE_NAMES)
with dataset.open(newline="") as f:
    rows = list(csv.DictReader(f))
groups = {k: {r["session_id"] for r in rows if r["split"] == k} for k in ("train","validation","test")}
assert len(rows) == 24000 and len(set.union(*groups.values())) == len(rows)
assert sum(map(len, groups.values())) == len(rows)
assert {k: len(g) for k,g in groups.items()} == {"train":16800,"validation":3600,"test":3600}
for r in rows:
    future = float(r["future_temperature_c"]), float(r["future_humidity_percent"])
    assert r["label_source"] == "simulated-future" and LABELS[int(band_label(*future))] == r["label"]
test = [r for r in rows if r["split"] == "test"]
x = np.array([[float(r[k]) for k in FEATURE_NAMES] for r in test], dtype=np.float32)
y = np.array([LABELS.index(r["label"]) for r in test])
scores, conversion = invoke_int8_tflite(tf, model, scale_features(x))
ok = scores.argmax(axis=1) == y
accept = scores.max(axis=1) >= 0.80
assert conversion["input"]["dtype"] == conversion["output"]["dtype"] == "int8"
totals = (int(ok.sum()), int(accept.sum()), int((ok & accept).sum()))
print(m["model_version"], "sessions", {k: len(g) for k,g in groups.items()})
print("desktop correct / accepted / accepted correct", *totals)
assert totals == (3142, 2769, 2631)
PY
```

Đối chiếu `ml/train_export.py` để kiểm tra nguồn đặc trưng. Mỗi cửa sổ đầu vào kết thúc tại thời điểm lấy quyết định; `build_dataset` dùng đoạn tương lai để tạo nhãn. `split_indices` chia theo phiên với seed cố định. `model.fit` học từ tập train và chọn trọng số bằng loss trên validation. `representative_dataset` dùng tối đa 1.024 mẫu train để hiệu chuẩn INT8. Tám tên cột đưa vào mạng xuất hiện trong manifest. Kiểm tra giao phiên và tên cột giúp phát hiện hai dạng rò rỉ cụ thể. Hiệu quả ngoài phòng lab cần những phiên thực nghiệm độc lập.

Với bản ghi thực tế, chạy `ml/import_history.py` với `--label-source observed-future` trên các trang JSON hoặc JSONL đã xuất. Bộ nhập yêu cầu bảy mẫu liên tục và khoảng 30 giây theo dõi sau mẫu cuối với trạng thái quạt lấy tại thời điểm đo giữ nguyên. Nó loại khoảng mất mẫu và nội suy giữa hai lần đo khi mốc +30 giây nằm giữa chúng. Mỗi cặp thiết bị/boot thuộc một phiên. Nếu cùng một thí nghiệm vật lý kéo dài qua nhiều boot, gom chúng vào cùng một `session_id` trước khi chia để tránh đưa cùng kích thích môi trường vào cả train và test.

### 6.4. Tái huấn luyện tùy chọn và so sánh năm tệp đầu ra

```bash
"$ML_PY" -u "$ROOT/ml/train_export.py" --seed 42 --epochs 70 --synthetic-samples 24000 \
  --output-dir "$RUN/candidate" > "$RUN/ml-train.log" 2>&1
"$ML_PY" - "$ROOT" "$RUN/candidate" <<'PY' | tee "$RUN/ml-candidate-check.txt"
import hashlib, json, sys
from pathlib import Path
base, candidate = map(Path, sys.argv[1:])
paths = ("ml/data/dataset.csv", "ml/models/dht_fan_model.tflite",
         "firmware/include/dht_fan_model.h", "firmware/include/fan_model_metadata.h",
         "ml/models/fan_model_manifest.json")
for rel in paths:
    a, b = (base / rel).read_bytes(), (candidate / rel).read_bytes()
    print("MATCH" if a == b else "DIFFER", rel, hashlib.sha256(b).hexdigest())
m = json.loads((candidate / paths[-1]).read_text())
print("candidate", m["model_version"], m["environment"], m["completed_epochs"], m["best_epoch_by_validation_loss"])
print("candidate test accuracy", m["metrics"]["test"]["int8_model"]["accuracy"])
PY
```

Với môi trường đã dùng để xuất bản đóng gói, mong đợi năm dòng `MATCH`, model 5.536 byte, mã `fan-trend-int8-v2-8abd0b91c744`, 70 epoch thực chạy, epoch 63 có validation loss tốt nhất. Khi có `DIFFER`, giữ cả hai bản và đối chiếu thứ tự từ CSV, model đến manifest. Nếu chỉ manifest khác, so sánh trường `environment`. Nếu model khác, kiểm tra phiên bản TensorFlow/Keras, seed, tập hiệu chuẩn và chấm lại candidate trước khi cân nhắc thay model trong firmware.

**Đọc khi hai bộ suy luận cho số khác nhau.** TFLite desktop chấm đúng 3.142/3.600, Micro trên host chấm đúng 3.151/3.600. Chuỗi bảy mẫu 27°C / 74,8% RH cho điểm cao nhất lần lượt 141/256 và 134/256. Các kernel INT8 có thể làm tròn khác nhau ở gần biên. Dùng kết quả Micro ở bước 4 khi mô tả phép thử với thư viện của firmware. Lấy điểm và thời gian suy luận thực tế từ board khi thực hiện bước 8.

<a id="ban-thu"></a>

## Bước 7 · Chuẩn bị buổi thử trên bàn

### 7.1. Nhận diện board, firmware và cổng Serial

Dùng ESP32-S3 đã nạp ứng dụng và bộ giao diện LittleFS của cùng phiên bản. DHT20 dùng SDA ở GPIO11, SCL ở GPIO12, dùng chung bus với LCD. GPIO10 mức HIGH điều khiển module relay hoặc mạch công suất của quạt. Chuẩn bị một cốc nước ấm để tạo thay đổi từ từ, đặt trên bàn vững và giữ mạch khô. Đặt quạt ở vị trí có thể quan sát cánh hoặc cảm nhận luồng gió. Đầu dò đất ở GPIO2 độc lập với phép thử này.

Trên Ubuntu, mở Terminal thứ hai, xác định cổng USB của board rồi mở monitor. Thay `/dev/ttyACM0` bằng cổng tìm được. Tùy chọn `log2file` ghi cả buổi thử vào tệp có đường dẫn in ra lúc mở monitor. Nhấn `Ctrl+C` để kết thúc ghi.

```bash
PIO=$(command -v pio || printf '%s' "$HOME/.platformio/penv/bin/pio")
"$PIO" device list
"$PIO" device monitor --port /dev/ttyACM0 --baud 115200 --filter log2file
```

Nếu có log khởi động, tìm `[BOOT] reset_reason=...` và `[AI] model=... arena_used=...B window_storage=...B`. Khi mở monitor muộn, có thể đọc model ở trang TinyML hoặc qua API bên dưới. Model đi kèm hướng dẫn này là `fan-trend-int8-v2-8abd0b91c744`. Nếu board đang chạy bản cũ, hoàn tất bước nạp firmware và giao diện trước khi so kết quả. `uploadfs` thay toàn bộ LittleFS. Giữ BOOT quá 2 giây khi chương trình đang chạy sẽ xóa ngưỡng quạt, Wi-Fi đã lưu, URL server và khởi động lại. Với board đang sử dụng, ghi lại cấu hình trước khi chủ động thay đổi hoặc nạp lại. Một lần khởi động lại thông thường giữ ngưỡng và đưa mode về AUTO. [Hướng dẫn nạp firmware và LittleFS](../GUIDE.md#7-step-5-build-flash--provision-the-esp32-s3-firmware)

### 7.2. Mở hai màn hình đúng trên ESP32

- **Đã lưu Wi-Fi, board kết nối thành công.** Đọc `STA Mode IP address: ...` trên Serial hoặc tìm IP của board trong danh sách máy khách của router. Kết nối máy thử vào cùng LAN, mở `http://<IP-của-board>/` rồi đăng nhập bằng tài khoản thiết bị đã cấu hình qua `DEVICE_HTTP_USER` và `DEVICE_HTTP_PASS`.
- **Board đang phát điểm truy cập.** Dùng SSID và mật khẩu AP của bản firmware (`SSID_AP`, `PASS_AP`), kết nối máy thử vào Wi-Fi đó, mở `http://192.168.4.1/` bằng trình duyệt thông thường. Serial hiển thị `AP Mode IP address: 192.168.4.1`. Đường truy cập này dùng mật khẩu Wi-Fi của AP. Nếu board kết nối lại vào router, chuyển máy thử về LAN và dùng IP STA vừa được cấp. Sáu ca dưới đây chỉ cần giao diện cục bộ và Serial.

Mở **Settings → Cấu hình FAN** (`/#settings/fan`) và **Settings → TinyML** (`/#settings/tinyml`) ở hai tab trên cùng địa chỉ. Tại tab FAN, nhấn `F12` → **Network**, bật **Preserve log**. Mỗi lần đổi ngưỡng, bấm **Lưu cấu hình FAN** và kiểm tra `POST /api/fan-config` trả **200**. Mỗi lần đổi mode, chọn trong ô **Chế độ**, bấm **Áp dụng**. Phản hồi **202** xác nhận thiết bị nhận yêu cầu. Chờ nhãn mode hiện hành và `fan_mode` đổi sang mode vừa chọn trước khi bắt đầu kích thích cảm biến. Nút **Đổi ON/OFF** dành cho MANUAL.

Từ tab của **thiết bị**, có thể đọc cấu hình và chụp trạng thái hiện tại bằng DevTools → **Console**. Đoạn sau chỉ đọc hai API bằng phiên trình duyệt hiện tại. Chạy một lần trước khi thay đổi để lưu ngưỡng và mode ban đầu, rồi chạy lại khi muốn sao chép một mẫu.

```js
for (const path of ["/api/fan-config", "/api/ai-status"]) {
  const r = await fetch(path, { cache: "no-store" });
  console.log(path, r.status, await r.text());
}
```

### 7.3. Đọc một mẫu và một cạnh GPIO

1. Tại TinyML, đợi **Sẵn sàng (INT8)** và cửa sổ **7/7**. Bảy mẫu cách nhau khoảng 5 giây nên mẫu đầu và mẫu thứ bảy cách nhau khoảng 30 giây. Chỉ tính các mẫu liên tiếp trong miền 5–50°C, 20–100% RH. Sau lỗi DHT, mất số thứ tự hoặc khoảng cách hai mẫu vượt 8 giây, quan sát `warming_up` rồi đợi đủ mẫu lại. Trong lúc chờ, quạt ở AI vẫn có thể bật theo luật dự phòng.
2. Đọc ba ô **Dự báo sau 30 giây**, **Luật ngưỡng tức thời (hồ sơ chuẩn)** và **Lệnh GPIO10 hiện tại**. Với mẫu `ready`, trường `ai.rule_class` dùng 30/28°C, 75/70%, OR. Trong SHADOW với ngưỡng tùy chỉnh, lý do `rule_on` hoặc `rule_off` phản ánh bộ ngưỡng người dùng đã lưu. Ba số `p` trên Serial lần lượt là OFF, HOLD, ON. Trường `fan_input` cho biết lệnh GPIO tại lúc lấy mẫu, trước quyết định của mẫu đó.
3. Mỗi dòng `[AI]` có `sample`, `sampled_ms`, `status`, `win` và `fan_input`. Khi suy luận sẵn sàng, dòng còn có T/RH, độ dốc, `reference`, `proposal`, `p` và độ trễ suy luận. Dòng `[FAN]` có `sample`, `decided_ms`, `mode`, `state` và `fan_reason`, xuất hiện khi lệnh, mode hoặc lý do thay đổi. Để xác định cạnh bật, tìm dòng đầu tiên chuyển từ `state=OFF` sang `state=ON`. Các dòng đổi lý do nhưng vẫn `state=ON` thuộc cùng một lần chạy.
4. Khi dùng JSON, ghi `boot_id` và đối chiếu `sample_seq`, `ai.sample_seq`, `fan_decision_sample_seq`. Khi ba số trùng nhau và AI đã xử lý xong mẫu, có thể ghép T/RH, dự báo và quyết định. Nếu thấy `stale` khi vừa sang mẫu mới, đọc lại hoặc ghép hai dòng Serial theo `sample`. Đo thời gian chuyển lệnh bằng `decided_ms` trên các **cạnh** Serial trong cùng lần khởi động. Trường `fan_decided_uptime_ms` ở API tiếp tục cập nhật khi bộ điều khiển chạy. Quan sát thêm chỉ báo relay và quạt thực tế để ghi nhận phần chấp hành.

<a id="hil"></a>

## Bước 8 · Thực hiện sáu phép thử HIL

### Ca 1 · Khóa SHADOW và AI khi chưa có ngưỡng dự phòng

**Điều kiện.** Dùng board thử ở lần cấp phát đầu tiên với `GET /api/fan-config` trả `configured=false`. Xác nhận FAN ở AUTO, GPIO10 OFF và `fan_reason=config_required`. Thực hiện ca này trước lần lưu ngưỡng đầu tiên. Nếu board đã có cấu hình cần giữ, ghi “chưa thử trên board này” rồi tiếp tục ca 2. Replay kiểm tra chính sách OFF khi thiếu cấu hình. Mã HTTP cần quan sát trên thiết bị.

1. Trong **Cấu hình FAN**, chọn **SHADOW · Quan sát AI** rồi bấm **Áp dụng**. Mở yêu cầu `/set-mode?mode=SHADOW` trong Network.
2. Lặp lại với **AI · Điều khiển thử nghiệm**. Mở yêu cầu `/set-mode?mode=AI`.
3. **Đạt** khi cả hai đều trả **409** với nội dung `Save a valid AUTO fallback configuration first`. Kiểm tra lại mode thực tế vẫn AUTO, lệnh vẫn OFF, lý do vẫn `config_required`. Nếu gặp **401**, đăng nhập lại phiên thiết bị. Nếu gặp **503**, đọc lại trạng thái khi thiết bị phản hồi ổn định rồi thử lại.

### Ca 2 · SHADOW quan sát AI trong khi luật người dùng điều khiển quạt

1. Nhập bốn ô nhiệt độ BẬT/TẮT **35 / 32°C**, độ ẩm BẬT/TẮT **85 / 80%**. Chọn **Nhiệt độ HOẶC độ ẩm (OR)**, bấm **Lưu cấu hình FAN**. Đọc lại `/api/fan-config`, kiểm tra `configured=true`, các số đúng và `activation_logic="any"`.
2. Chọn SHADOW → **Áp dụng**. Bắt đầu khi quạt OFF, cửa sổ 7/7, đã qua ít nhất 10 giây từ lúc đổi mode. Đưa cốc gần dần qua vài kỳ lấy mẫu, theo dõi RH vượt 75% nhưng vẫn dưới 85%, giữ T dưới 35°C. Có thể giữ RH quanh 77% thêm vài mẫu để mô hình nhìn thấy mức ẩm duy trì.
3. **Đạt** khi cùng mẫu có `ai.status=ready`, `predicted_class=ON`, `fan_mode=SHADOW`, `fan_state=OFF`, `fan_reason=rule_off`, quạt trên bàn vẫn tắt. Ở RH ≥ 75%, ô luật chuẩn có thể hiện ON cùng lúc. Mức BẬT thực tế của SHADOW ở lượt này vẫn là 35°C hoặc 85% RH. Nếu đã chạm một trong hai ngưỡng đó, để cả T ≤ 32°C và RH ≤ 80% cho quạt nhả rồi lặp lại. Nếu chưa bắt được đề xuất ON, giữ lại log và ghi “chưa tạo được điều kiện”.

### Ca 3 · Giữ ngưỡng tùy chỉnh và chuyển AI để thấy profile mismatch

1. Giữ nguyên ngưỡng ở ca 2. Khi quạt đang OFF và T < 35°C, RH < 85%, chọn **AI** → **Áp dụng**.
2. Kiểm tra `/set-mode?mode=AI` trả **202**. Chờ `fan_mode=AI` và trạng thái chuyển tiếp `mode_changed` kết thúc. Đọc TinyML trong lúc DHT hợp lệ và mô hình sẵn sàng.
3. **Đạt** khi thấy `ai_fallback_profile_mismatch` và GPIO theo ngưỡng tùy chỉnh. Tốt nhất chụp được cùng mẫu mô hình còn đề xuất ON nhưng GPIO OFF. Nếu nhiệt hoặc ẩm vượt ngưỡng tùy chỉnh sau thời gian giữ OFF, luật dự phòng có thể bật GPIO với cùng lý do mismatch. Ca 1 kiểm tra từ chối vào mode, còn ở ca này thiết bị đã nhận mode AI và đang dùng bộ điều khiển dự phòng.

### Ca 4 · Bật đón đầu, đối chứng xu hướng giảm và đo thời gian giữ ON

**Chuẩn bị.** Lưu T BẬT/TẮT **30 / 28°C**, RH BẬT/TẮT **75 / 70%**, chọn **OR**. Trong mỗi lượt, bắt đầu khi quạt OFF, mẫu hợp lệ 7/7, hết 10 giây giữ OFF sau khi đổi mode hoặc ngưỡng. Chọn nơi có thể giữ T dưới 30°C và RH dưới 75% trước khi tạo đợt tăng. Nếu nhiệt độ phòng đã luôn trên 30°C thì luật tĩnh đã đủ điều kiện bật.

- **Lượt đối chứng.** Chọn SHADOW với chính bộ ngưỡng chuẩn. Từ mức ẩm thấp, đưa cốc lại gần qua vài mẫu để RH tăng dần đến khoảng 71–74%, T vẫn dưới 30°C. Tìm một mẫu với `rule_class=HOLD`, `predicted_class=ON`, điểm ON ≥ 0,80, lệnh vẫn OFF/`rule_off`. Trong SHADOW có thể giữ nguyên kích thích đến khi T ≥ 30°C hoặc RH ≥ 75%. Ghi thời gian từ đề xuất sớm đủ điểm tới lần bật thực tế đầu tiên do luật. Đây là thời gian đi trước của **đề xuất** trên cùng chuỗi SHADOW.
- **Lượt AI tăng.** Để môi trường về mức xuất phát rồi chọn AI. Lặp lại quãng đưa cốc như trên. Dấu hiệu bật đón đầu là cùng mẫu có T < 30°C, RH < 75%, `rule_class=HOLD`, `fan_on_at_sample=false`, `predicted_class=ON`, điểm ON ≥ 0,80 và cạnh GPIO OFF → ON với `ai_proactive_on`. Ghi cả chỉ báo relay hoặc chuyển động quạt. Nếu lần bật đầu tiên chỉ xuất hiện khi đã chạm ngưỡng cao, lượt đó chứng minh bật ở ngưỡng. Thử đưa cốc chậm hơn để thu nhiều mẫu phía dưới ngưỡng.
- **Lượt AI giảm.** Tạo một lượt riêng với quạt ban đầu OFF. Có thể chuẩn bị mức RH gần 74% trong SHADOW với hồ sơ chuẩn và chưa chạm ngưỡng BẬT. Chuyển AI, chờ hết giữ OFF, sau đó đưa cốc xa dần. Chọn một mẫu có T/RH cuối gần với mẫu tăng, dốc RH âm, `fan_on_at_sample=false` và quạt vẫn OFF. Ghi dự báo, điểm và lý do. Nếu xuất hiện `ai_fallback_low_score`, đó là một lần dùng luật dự phòng. Muốn minh họa mô hình phân biệt chiều xu hướng, tìm cửa sổ giảm cho đề xuất OFF hoặc HOLD đủ điểm và so với cửa sổ tăng cho ON đủ điểm.
- **Kiểm tra tại ngưỡng cao.** Trong AI, giữ cốc đủ lâu để RH thực đo ≥ 75% hoặc T ≥ 30°C. Sau thời gian giữ OFF, GPIO phải ON. Với đề xuất ON đủ điểm, lý do là `ai_on`. Nếu dự báo đủ điểm là HOLD hoặc OFF, bộ giám sát vẫn yêu cầu bật với `ai_guard_threshold_on`. Khi giảm trở lại dải HOLD, quạt đang chạy sẽ giữ ON. Đề xuất HOLD đủ điểm cho `ai_hold`, còn đề xuất OFF đủ điểm cho `ai_guard_hysteresis`.
- **Lượt đo giữ trễ.** Ở một lần AI vừa bật, ghi `t_on = decided_ms` của cạnh ON rồi lấy cốc ra khoảng giây thứ 3. DHT đọc mỗi khoảng 5 giây. Nếu trước `t_on + 10000` đã có mẫu với **cả** T ≤ 28°C và RH ≤ 70%, mong đợi GPIO vẫn ON và `min_on_time`. Giữ môi trường tiếp tục ở vùng thấp. Lấy `t_off` ở cạnh OFF tiếp theo. Với mode và cấu hình giữ nguyên, DHT hợp lệ xuyên suốt, cần `t_off - t_on ≥ 10000` ms. Trong dải HOLD, quạt đang chạy tiếp tục ON. Khi cả hai giá trị đã thấp và hết giữ trễ, lý do có thể là `ai_off`, `ai_guard_threshold_off` hoặc một lý do dùng luật dự phòng, tùy dự báo của mẫu đó. Nếu T phòng luôn trên 28°C hoặc cảm biến nguội chậm, ghi “chưa kích được nhánh `min_on_time`”. Dòng `cool at +5s` của replay tái hiện chính xác điều kiện này.

Ghi kết quả đạt hoặc chưa đủ bằng chứng cho từng lượt. Hai lần đưa cốc bằng tay tạo hai chuỗi khác nhau, và quạt thật có thể làm thay đổi RH sau khi bật. Phép so sánh đúng cùng đầu vào cho mức bật sớm 20 giây nằm trong replay.

### Ca 5 · Tạo quyết định softmax dưới 0,80 và kiểm tra luật dự phòng

1. Giữ AI với profile chuẩn, quạt OFF, đã hết giữ OFF. Ở một lượt riêng, đưa cốc đến vùng gần ngưỡng rồi điều chỉnh từng ít một. Một điểm xuất phát từ replay là **7 mẫu ở khoảng 27°C / 74,8% RH**, cách nhau 5 giây. Trên bàn, thử giữ tương đối ổn định qua cả cửa sổ rồi thay đổi nhẹ khoảng cách qua các mẫu kế tiếp.
2. Đọc ba điểm **OFF / HOLD / ON**. Khi cả ba đều dưới 0,80 và `status=ready`, chụp JSON hoặc log của đúng mẫu. Dùng `ai.probabilities` để đối chiếu nếu phần hiển thị đã làm tròn. Ngoài giá trị hiện tại, mô hình còn dùng độ dốc, dao động và lệnh quạt tại lúc lấy mẫu.
3. **Đạt** khi `fan_reason=ai_fallback_low_score` và lệnh theo luật. Ví dụ tại 27°C / 74,8%, T và RH đều dưới ngưỡng BẬT, quạt đang OFF sẽ tiếp tục OFF. Nếu bộ điều khiển đang phải trì hoãn một cạnh, lý do hiển thị có thể là `min_on_time` hoặc `min_off_time`. Chọn mẫu ngoài thời gian giữ để thấy trực tiếp lý do điểm thấp. Nếu mọi mẫu đều có điểm tối đa ≥ 0,80, ghi “chưa tạo được điểm thấp trên board” và dùng dòng `low score` của replay làm đối chứng phần mềm.

### Ca 6 · Rút nhánh tín hiệu DHT20 khi quạt ON, sau đó kiểm tra hồi phục

1. Giữ AI với profile chuẩn. Bố trí sẵn một dây tín hiệu dễ tháo **ở nhánh DHT20** để LCD vẫn có SDA/SCL. Dùng quạt bàn nguồn DC điện áp thấp, tách thao tác khỏi đầu cấp nguồn quạt và tiếp điểm tải. Chờ cạnh ON mới, ghi `decided_ms` và bắt đầu quay video nếu muốn đo thời gian dây rời đến lúc chỉ báo relay tắt.
2. Ngắt riêng SDA (GPIO11) **hoặc** SCL (GPIO12) của cảm biến ngay sau cạnh ON và giữ ngắt qua chu kỳ đọc tiếp theo. Theo dõi Serial, TinyML và relay. Khi DHT đọc lỗi, mong đợi `ai.status=sensor_invalid`, `window_samples=0`, T/RH và đề xuất trên API là `null`. Cùng số mẫu bị lỗi, bộ điều khiển phải ra `state=OFF fan_reason=sensor_invalid`, bỏ qua 10 giây giữ ON. Cánh quạt có thể tiếp tục quay theo quán tính sau khi relay đã ngắt.
3. **Đạt** nếu mẫu lỗi đầu tiên dẫn đến lệnh OFF và relay nhả. Nếu `decided_ms` của cạnh OFF cách cạnh ON dưới 10.000 ms thì lượt này cũng chứng minh được quyền bỏ qua giữ trễ. Lấy `decided_ms(OFF) − sampled_ms(mẫu lỗi)` để đo độ trễ từ khi firmware ghi nhận lỗi tới lệnh GPIO. Dùng mốc ngoài như video để đo từ lúc tháo dây tới lúc ngắt relay. Chu kỳ DHT danh định là 5 giây, thao tác I²C và lập lịch còn góp vào số đo. Nếu số mẫu ngừng tăng thay vì xuất hiện mẫu lỗi mới, bộ điều khiển có đường ngắt khi tuổi mẫu vượt 15 giây. Ghi riêng tình huống mẫu quá hạn.
4. Cắm lại dây và bỏ nguồn hơi. Quan sát các mẫu mới trong miền, đầu tiên `warming_up` với 1/7, sau đó 7/7 và `ready` sau khoảng 30 giây kể từ mẫu hợp lệ đầu tiên. Trong lúc chờ, AI có thể điều khiển bằng luật ngưỡng. Kết thúc buổi thử bằng cách lưu lại ngưỡng và mode ban đầu nếu đây là board đang sử dụng, rồi xác nhận qua `/api/fan-config` và `/api/status`. Với board mới cấp phát, chọn cấu hình và mode muốn sử dụng sau buổi thử.

<a id="lich-su"></a>

## Bước 9 · Đối chiếu telemetry và chấm dự báo trên phiên đo thật

Sau các ca HIL, dùng **Settings → TinyML** và phản hồi `GET /api/ai-status` để lấy một mẫu đối chiếu cho bản xuất. Tỷ lệ khớp trên màn hình đếm số lần đề xuất AI trùng với luật tức thời trên cùng mẫu. Đánh giá dự báo cần chờ đến +30 giây.

- Ghi `boot_id`, `sample_seq`, `sampled_uptime_ms` và `ai.model_version`. Với `ai.status=ready`, số thứ tự và uptime bên trong `ai` phải trùng cấp ngoài, cửa sổ có đủ 7 mẫu. Ba điểm `ai.probabilities` theo thứ tự **OFF, HOLD, ON**. Các trạng thái `warming_up`, `sensor_invalid`, `stale`, `out_of_domain` có đề xuất và điểm bằng null.
- `ai.fan_on_at_sample` là lệnh GPIO khi lấy mẫu, `ai.predicted_class` là đề xuất và `ai.rule_class` là hành động theo ngưỡng của mô hình ở thời điểm hiện tại. `fan_state`, `fan_mode`, `fan_reason` ghi lệnh điều khiển gần nhất. Chỉ ghép lần bật/tắt với mẫu đang xem khi `fan_decision_sample_seq == sample_seq`. Hai nhóm trường được chụp dưới hai khóa khác nhau. Ví dụ trong SHADOW, cùng một mẫu có thể có `ON / HOLD / OFF` lần lượt ở đề xuất, luật tức thời và GPIO. Dùng Serial và quan sát vật lý từ bước HIL để xác nhận cạnh GPIO và đáp ứng của quạt.

### 9.1. Xuất phiên đo và kiểm tra bản ghi

Nếu chỉ chạy trên máy và chưa có lịch sử từ board, đánh dấu bước này “chưa có phiên thực”. Khi đã có hệ thống thu thập, trên trang Admin chọn **Khoảng thời gian xuất dữ liệu lab**, đặt **Từ / Đến**, rồi chọn **Xuất dữ liệu JSONL** ở đúng thẻ thiết bị. Khoảng lọc kể từ mốc đầu đến trước mốc cuối theo giờ trình duyệt, áp dụng trên thời gian tiếp nhận của backend (hoặc thời gian upload nếu thiếu). Trình duyệt gọi `GET /admin/api/history` theo trang, giữ `until_id` cố định và tăng `after_id`. Tệp có thể chứa nhiều sự kiện `sensor`, `ai`, `fan` cho một lần lấy mẫu hoặc thiếu mẫu khi đường truyền gián đoạn. Trong lịch sử, các tên cấp ngoài là `FAN_state` và `MODE_state`.

Trong Terminal đã đặt `ROOT`, `RUN` và `ML_PY`, chép tệp vừa tải vào thư mục bằng chứng. Khi được hỏi, nhập đường dẫn đầy đủ của tệp JSONL. Kiểm tra máy có Node.js để chạy hàm xác thực đi kèm backend.

```bash
read -r -p 'Đường dẫn đến file JSONL đã xuất: ' HISTORY_FILE
cp -- "$HISTORY_FILE" "$RUN/history.jsonl"
node --version
```

Các lệnh dưới đây chỉ đọc bản xuất cục bộ và tạo kết quả trong thư mục lần chạy. Dùng thư mục lần chạy mới khi cần tạo lại CSV vì công cụ nhập bảo vệ tệp đầu ra đã tồn tại.

```bash
cd "$ROOT"
node - "$RUN/history.jsonl" <<'JS' | tee "$RUN/history-status.txt"
const fs = require('node:fs');
const { validExperimentFields } = require('./services/backend/src/telemetry');
const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/).filter(Boolean);
if (!lines.length) throw new Error('JSONL rỗng');
const statuses = new Map();
for (const [i, s] of lines.entries()) {
  const r = JSON.parse(s);
  if (!validExperimentFields(r)) throw new Error('Sai trường telemetry tại dòng ' + (i + 1));
  const status = r.ai?.status || '(thiếu AI)';
  statuses.set(status, (statuses.get(status) || 0) + 1);
}
console.log('Số bản ghi theo trạng thái', Object.fromEntries(statuses));
JS

PYTHONDONTWRITEBYTECODE=1 "$ML_PY" "$ROOT/ml/import_history.py" "$RUN/history.jsonl" \
  --label-source observed-future --output "$RUN/observed.csv" | tee "$RUN/history-import.txt"
```

Đọc báo cáo của bộ nhập. `input_rows` đếm sự kiện. `unique_in_domain_samples` đếm mẫu riêng biệt trong miền. `windows` là số cửa sổ gán được nhãn. `duplicate_rows`, `gap_resets`, `windows_missing_sampled_command` và `windows_missing_contiguous_same_command_future` giúp giải thích vì sao các số này khác nhau. Công cụ gom theo thiết bị và boot, cắt chuỗi khi số thứ tự gián đoạn hoặc khoảng thời gian giữa hai mẫu nằm ngoài (0, 8 giây]. Nó lấy lệnh quạt từ bản ghi suy luận khớp với mẫu và cần lệnh này giữ cùng giá trị ở các lần lấy mẫu tiếp theo tới mốc +30 giây. Nếu mốc nằm giữa hai mẫu, công cụ nội suy tuyến tính T/RH. Ở nhịp đúng 5 giây, 7 mẫu quá khứ cùng 6 mẫu tiếp theo cho **một** dự báo có thể chấm. Ví dụ nếu mẫu 7 ở giây 35 có RH 72%, mẫu 13 ở giây 65 có RH 78%, suốt khoảng đó T = 27°C và GPIO giữ OFF, nhãn của mẫu 7 là **ON**. Muốn đối chiếu hãy lấy đề xuất đã ghi ở mẫu 7, còn mẫu 13 cung cấp kết quả quan sát. Đổi GPIO rồi đổi lại giữa hai lần lấy mẫu có thể không xuất hiện trong lịch sử. Ghi lại các can thiệp khi làm HIL.

Nhãn `ON` khi T ở +30 giây ≥ 30°C **hoặc** RH ≥ 75%. Nhãn `OFF` khi T ≤ 28°C **và** RH ≤ 70%. Các trường hợp còn lại mang nhãn `HOLD`. Ví dụ một lượt dự báo ON sớm làm quạt bật có thể thiếu nhãn do lệnh quạt thay đổi trong 30 giây sau đó. Lượt ấy vẫn có giá trị chứng minh đường điều khiển. Để đánh giá dự báo dưới giả thiết lệnh quạt giữ nguyên, thu thêm phiên SHADOW có quãng GPIO ổn định và có cả đoạn tăng, giảm, đứng yên.

### 9.2. Đo chất lượng dự báo đã ghi trên thiết bị

Chạy sau khi có `observed.csv`. Đoạn mã ghép **đề xuất đã chạy trên board** với nhãn tương lai theo thiết bị, boot, số thứ tự và uptime. Nó chọn đúng phiên bản trong manifest hiện tại và chấm luật tức thời trên chính các mẫu đó. Ở dòng kết quả, mỗi phân số là số lần khớp chia cho số cửa sổ trong nhóm. `qua_cổng` là tỷ lệ có điểm ≥ 0,80 trước khi xét giám sát và thời gian giữ relay.

```bash
cd "$ROOT"
PYTHONPATH="$ROOT/ml" PYTHONDONTWRITEBYTECODE=1 "$ML_PY" - "$RUN" <<'PY' | tee "$RUN/field-scores.txt"
import csv, json, sys
from collections import Counter, defaultdict
from math import ceil
from statistics import median
from pathlib import Path
from urllib.parse import quote
from import_history import read_rows, sampled_fan

run = Path(sys.argv[1])
version = json.loads(Path('ml/models/fan_model_manifest.json').read_text())['model_version']
predictions, timings = {}, {}
for row in read_rows(run / 'history.jsonl'):
    if sampled_fan(row) is None:
        continue
    ai = row['ai']
    if ai['model_version'] != version:
        continue
    session = ':'.join(quote(row[k], safe='') for k in ('device_id', 'boot_id'))
    key = session, int(row['sample_seq']), int(row['sampled_uptime_ms'])
    item = ai['predicted_class'], ai['rule_class'], max(ai['probabilities'])
    timings[key] = ai['inference_ms']
    if predictions.setdefault(key, item) != item:
        raise ValueError(f'Có hai dự báo khác nhau cho cùng mẫu {key}')

if timings:
    latencies = sorted(timings.values())
    print('Suy luận trên các mẫu ready, ms: n, median, p95',
          len(latencies), median(latencies), latencies[ceil(.95 * len(latencies)) - 1])

counts, labels = defaultdict(Counter), Counter()
with (run / 'observed.csv').open() as source:
    for row in csv.DictReader(source):
        session = row['session_id']
        key = session, int(row['sample_seq']), int(row['sampled_uptime_ms'])
        if key not in predictions:
            continue
        proposal, static, score = predictions[key]
        target = row['label']
        labels[target] += 1
        c = counts[session]
        c['n'] += 1
        c['ai'] += proposal == target
        c['rule'] += static == target
        c['gate'] += score >= .80
        c['correct_gate'] += score >= .80 and proposal == target
        if static == 'HOLD' and float(row['fan_on_at_sample']) == 0:
            c['eligible'] += 1
            early = proposal == 'ON' and score >= .80
            c['tp'] += early and target == 'ON'
            c['fp'] += early and target != 'ON'
            c['fn'] += not early and target == 'ON'

if not counts:
    raise SystemExit('Không có dự báo khớp với phiên bản mô hình và nhãn +30 giây.')
print('model', version, 'số phiên', len(counts), 'số nhãn', dict(labels))
for session, c in [*sorted(counts.items()), ('TỔNG', sum(counts.values(), Counter()))]:
    accepted_accuracy = f"{c['correct_gate']}/{c['gate']}" if c['gate'] else 'N/A'
    print(session, f"AI {c['ai']}/{c['n']}, luật {c['rule']}/{c['n']}, "
          f"qua_cổng {c['gate']}/{c['n']}, đúng_sau_cổng {accepted_accuracy}, "
          f"cơ_hội_bật_sớm {c['eligible']}, TP/FP/FN {c['tp']}/{c['fp']}/{c['fn']}")
PY
```

Dòng độ trễ lấy mỗi mẫu `ready` đúng phiên bản một lần, kể cả khi chưa có nhãn tương lai. Median là trung vị; p95 là giá trị ở hạng làm tròn lên của 95% số mẫu đã sắp xếp. Firmware đo thời gian mã hóa đầu vào, gọi model và giải mã điểm trong `inference_.invoke`. Để biết độ trễ từ lỗi cảm biến đến cạnh GPIO, dùng phép đo ở ca 6.

Với quạt OFF ở lúc lấy mẫu và luật tức thời HOLD, `TP` đếm đề xuất ON đủ điểm mà môi trường đạt dải ON ở +30 giây. `FP` đếm đề xuất ON đủ điểm khi tương lai vẫn OFF/HOLD. `FN` đếm cửa sổ tương lai ON nhưng mô hình chưa đề xuất ON đủ điểm. Mẫu số là các cơ hội có nhãn dưới giả thiết lệnh quạt ổn định. Khi không có mẫu qua cổng, tỷ lệ đúng của nhóm đó là `N/A`. Khi báo cáo, ghi số phiên, số cửa sổ đủ nhãn, phân bố OFF/HOLD/ON và kết quả từng phiên. Những cửa sổ chồng lấn trong cùng buổi chịu cùng điều kiện đo. Để so sánh với thí nghiệm mô phỏng hoặc giữa hai phiên bản mô hình, ghi rõ nguồn dữ liệu, phiên bản, mẫu số và tiêu chí loại cửa sổ. Muốn lượng hóa quạt làm mát nhanh hơn, cần một phép đo đối chứng riêng về tác động vật lý.

<a id="ket-luan"></a>

## Bước 10 · Kết luận từng phép thử và lưu bằng chứng

Dùng ba trạng thái cho mỗi ca: **Đạt** khi đủ điều kiện đầu vào và quan sát đúng đầu ra, **Không đạt** khi đủ điều kiện nhưng đầu ra sai, **Chưa đủ bằng chứng** khi chưa chạy hoặc chưa tạo được kích thích yêu cầu. Ví dụ, nếu RH không bao giờ hạ dưới 70% trong 10 giây đầu, lượt đó chưa kiểm tra được nhánh giữ trễ. Ghi “chưa chạy HIL” cho các ca mới chỉ có bằng chứng replay.

Lập một biên bản cho mỗi lần thử theo mẫu sau. Có thể dùng file văn bản trong `$RUN` hoặc sổ lab.

```text
Ca / lần thử / nguồn (host, board hoặc dữ liệu đo đã xuất):
Phiên bản model / thiết bị / boot_id:
Mode / profile đang lưu / lệnh quạt ban đầu:
Điều kiện đã tạo và thời điểm tác động:
sample_seq / sampled_ms / T / RH / dT / dRH / số mẫu:
rule_class / predicted_class / p[OFF,HOLD,ON]:
fan_decision_sample_seq / decided_ms / fan_reason / lệnh GPIO:
Quan sát relay, quạt hoặc phép đo riêng:
Mong đợi / thực tế / kết luận / tên file log hoặc ảnh:
```

**Khi kết quả khác mong đợi**, kiểm tra theo thứ tự:

1. **Build hoặc chấm sai phiên bản.** Đọc lỗi đầu tiên trong `build.log`, kiểm tra phiên bản và SHA tại bước 2. Khi nâng firmware và web assets ở hai thời điểm khác nhau, đối chiếu tên model qua API, kiểm tra bản giao diện đã nạp và tải lại trang. Bản ghi cũ có thể thiếu các trường AI hiện tại.
2. **TinyML hiện `warming_up` mãi.** Tìm các lần đếm lại 1/7 trên Serial. So `sample` và `sampled_ms` giữa hai dòng liên tiếp, kiểm tra lỗi DHT, miền đầu vào hoặc khoảng cách quá 8 giây. Nếu mẫu vẫn mới mà chỉ đề xuất của mẫu trước hiện ra, chờ bản ghi `[AI]` của đúng mẫu.
3. **AI đề xuất ON nhưng quạt OFF.** Xem mode thực tế, `fan_reason`, hai mã mẫu, ngưỡng đã lưu, điểm ON và thời gian kể từ cạnh OFF cuối. SHADOW, profile mismatch, `min_off_time`, điểm thấp và hai kênh đang dưới ngưỡng OFF là những trường hợp có thể kiểm tra riêng. Nếu lệnh GPIO đã ON nhưng relay/quạt chưa hoạt động, kiểm tra tầng chấp hành bằng quan sát độc lập.
4. **Không thu được số liệu ở Admin.** Hãy hoàn thành kiểm tra cục bộ bằng Serial và TinyML trước. Kiểm tra board đã vào STA, URL backend và đồng hồ đã đồng bộ; kiểm tra lỗi POST trên Serial rồi xuất lại đúng thiết bị, đúng khoảng thời gian. Nếu JSONL có bản ghi nhưng bộ nhập thiếu cửa sổ, xem thống kê ở bước 9. [Cấu hình và kiểm tra đường telemetry](../GUIDE.md)
5. **Tỷ lệ chính xác trên phiên thật thấp.** Báo cả số phiên, phân bố nhãn, mẫu qua cổng, mẫu thiếu và tần suất bật sớm sai. Đọc lại các cửa sổ mắc lỗi và kích thích tại thời điểm đó. Tập tổng hợp mô phỏng diễn biến và tác động của quạt theo giả thiết. Để đo khả năng khái quát, dành riêng các buổi thử chưa dùng để điều chỉnh model hoặc chọn ngưỡng điểm.

`$RUN` mặc định nằm trong thư mục tạm. Nếu muốn giữ bằng chứng sau khi khởi động lại máy, sao chép có chọn lọc log và kết quả vào thư mục cá nhân. Ví dụ sau lưu các tệp ở ngay cấp gốc, bỏ qua thư mục build và môi trường Python có dung lượng lớn. Lưu thêm ảnh/video HIL từ nơi bạn đã ghi.

```bash
mkdir -p "$HOME/Documents/TinyML-audit"
EVIDENCE=$(mktemp -d "$HOME/Documents/TinyML-audit/run.XXXXXXXX")
find "$RUN" -maxdepth 1 -type f -exec cp -t "$EVIDENCE" -- {} +
printf 'Đã lưu kết quả tại %s\n' "$EVIDENCE"
```

**Dùng trong Portfolio.** Một minh chứng ngắn gồm hai cửa sổ cùng T/RH cuối nhưng dự báo khác nhau, một dòng cho thấy luật giữ quyền điều khiển và một kết quả chấm có mẫu số. Trên bàn thử, có thể đo thêm thời gian bật trước ngưỡng ở cùng một chuỗi SHADOW, độ trễ suy luận từ trường `inference_ms` của các mẫu `ready`, và thời gian từ mẫu lỗi đến khi GPIO OFF. Nếu chạy quạt làm thay đổi diễn biến T/RH, hãy ghi thành một lượt vật lý riêng. Muốn kết luận giảm nhiệt, giảm ẩm hoặc điện năng cần số đo tác động trong điều kiện so sánh tương đương.

Ví dụ câu CV dựa trên kết quả host:

> Built an INT8 ventilation controller for ESP32-S3 using TensorFlow Lite Micro and FreeRTOS. Predicted the temperature/humidity band 30 seconds ahead with 87.5% accuracy across 3,600 held-out synthetic traces and verified deterministic fallback and sensor-fault shutdown in host replay.
