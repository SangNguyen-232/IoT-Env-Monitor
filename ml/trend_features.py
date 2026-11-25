"""Feature and forecast contract shared by training, model export and history import."""
import numpy as np

LABELS = ("OFF", "HOLD", "ON")
FEATURE_NAMES = ("u_temp", "u_humi", "v_temp", "v_humi", "s_temp", "s_humi", "jitter", "fan_on_at_sample")
FEATURE_CLIP = 4.0
FEATURE_SCALES = np.array([4.0] * 7 + [1.0], dtype=np.float32)
T_MIN, T_MAX, H_MIN, H_MAX = 5.0, 50.0, 20.0, 100.0
REF_T_ON, REF_T_OFF, REF_H_ON, REF_H_OFF = 30.0, 28.0, 75.0, 70.0
WINDOW_SIZE = 7
MAX_STEP_GAP_MS = 8000
HORIZON_SECONDS = 30
PROFILE = "trend-or-30-28-75-70-30s-v2"


def extract_window_features(temps, humis, times_s, fan_on):
    """Mirror TemporalWindow::extract. Times are unwrapped seconds within one boot."""
    readings = np.column_stack((temps, humis)).astype(np.float32).astype(np.float64)
    times = np.asarray(times_s, dtype=np.float64)
    if readings.shape != (WINDOW_SIZE, 2) or times.shape != (WINDOW_SIZE,):
        raise ValueError(f"Exactly {WINDOW_SIZE} contiguous readings are required")
    if not np.all(np.isfinite(readings)) or not np.all(np.isfinite(times)):
        raise ValueError("Nonfinite reading or sample time")
    if np.any(readings < [T_MIN, H_MIN]) or np.any(readings > [T_MAX, H_MAX]):
        raise ValueError("Reading outside the model domain")
    delta = np.diff(times)
    if np.any(delta <= 0) or np.any(delta > MAX_STEP_GAP_MS / 1000.0):
        raise ValueError("Repeated or noncontiguous sample times")
    if fan_on not in (True, False):
        raise ValueError("Expected a binary pre-decision fan command")
    centered = times - times.mean()
    slope = (centered @ (readings - readings.mean(axis=0))) / (centered @ centered)
    residual = readings - readings.mean(axis=0) - centered[:, None] * slope
    band = np.array([REF_T_ON - REF_T_OFF, REF_H_ON - REF_H_OFF])
    position = (readings[-1] - [REF_T_OFF, REF_H_OFF]) / band
    last_slope = (readings[-1] - readings[-2]) / delta[-1]
    jitter = np.sqrt(np.mean(np.sum((residual / band) ** 2, axis=1)))
    raw = np.r_[position, 60 * slope / band, 60 * last_slope / band, jitter, float(fan_on)]
    return np.clip(raw, -FEATURE_CLIP, FEATURE_CLIP).astype(np.float32)


def scale_features(raw):
    return np.clip(raw / FEATURE_SCALES, -1.0, 1.0).astype(np.float32)


def band_label(temperature, humidity):
    """Threshold region of an observed sample; indices select OFF/HOLD/ON."""
    return np.where((temperature >= REF_T_ON) | (humidity >= REF_H_ON), 2,
                    np.where((temperature <= REF_T_OFF) & (humidity <= REF_H_OFF), 0, 1))
