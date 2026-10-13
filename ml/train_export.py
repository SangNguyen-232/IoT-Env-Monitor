from __future__ import annotations
 
import csv
import os
import sys
import numpy as np
import contextlib
 
 
def _score_temperature(t: float) -> float:
    if 15.0 <= t <= 25.0:
        return 0.0
    if 10.0 <= t < 15.0:
        return 5.0 * ((15.0 - t) / 5.0)
    if 25.0 < t <= 30.0:
        return 5.0 * ((t - 25.0) / 5.0)
    if t < 10.0:
        return 5.0 + 5.0 * min((10.0 - t) / 10.0, 1.0)
    return 5.0 + 5.0 * min((t - 30.0) / 10.0, 1.0)
 
 
def _score_humidity(h: float) -> float:
    if 60.0 <= h <= 70.0:
        return 0.0
    if 50.0 <= h < 60.0:
        return 5.0 * ((60.0 - h) / 10.0)
    if 70.0 < h <= 80.0:
        return 5.0 * ((h - 70.0) / 10.0)
    if h < 50.0:
        return 5.0 + 5.0 * min((50.0 - h) / 20.0, 1.0)
    return 5.0 + 5.0 * min((h - 80.0) / 15.0, 1.0)
 
 
def _score_soil(s: float) -> float:
    if 30.0 <= s <= 40.0:
        return 0.0
    if 25.0 <= s < 30.0:
        return 5.0 * ((30.0 - s) / 5.0)
    if 40.0 < s <= 45.0:
        return 5.0 * ((s - 40.0) / 5.0)
    if s < 25.0:
        return 5.0 + 5.0 * min((25.0 - s) / 20.0, 1.0)
    return 5.0 + 5.0 * min((s - 45.0) / 15.0, 1.0)
 
 
def final_label(t: float, h: float, s: float) -> int:
    r = 0.35 * _score_temperature(t) + 0.20 * _score_humidity(h) + 0.45 * _score_soil(s)
    if r <= 3.0:
        return 1
    if r <= 6.5:
        return 2
    return 3
 
 
def build_dataset(
    rng: np.random.Generator, n_extra: int = 5000
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rows: list[tuple[float, float, float, int]] = []
 
    # Dense scanning around new boundary nodes so the model learns the decision boundaries accurately
    for t in np.linspace(5.0, 50.0, 20):
        for h in np.linspace(20.0, 100.0, 20):
            for s in np.linspace(0.0, 100.0, 20):
                for _ in range(2):
                    tt = float(t + rng.normal(0, 0.2))
                    hh = float(h + rng.normal(0, 0.3))
                    ss = float(np.clip(s + rng.normal(0, 0.5), 0.0, 100.0))
                    rows.append((tt, hh, ss, final_label(tt, hh, ss)))
 
    for _ in range(n_extra):
        tt = float(rng.uniform(5.0, 50.0))
        hh = float(rng.uniform(20.0, 100.0))
        ss = float(rng.uniform(0.0, 100.0))
        rows.append((tt, hh, ss, final_label(tt, hh, ss)))
 
    xs = np.array([[r[0], r[1], r[2]] for r in rows], dtype=np.float32)
    ys = np.array([r[3] for r in rows], dtype=np.int32)
    ys0 = ys - 1
    return xs, ys, ys0
 
 
def write_csv(path: str, xs: np.ndarray, ys: np.ndarray) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["temperature", "humidity", "soil_moisture", "final_label"])
        for (t, h, s), lab in zip(xs, ys):
            w.writerow([f"{t:.4f}", f"{h:.4f}", f"{s:.4f}", int(lab)])
 
 
def tflite_to_header(tflite_bytes: bytes, out_path: str) -> None:
    lines = ["#pragma once", "", "const unsigned char dht_anomaly_model_tflite[] = {"]
    row: list[str] = []
    for b in tflite_bytes:
        row.append(f"0x{b:02x}")
        if len(row) == 12:
            lines.append("  " + ", ".join(row) + ",")
            row = []
    if row:
        lines.append("  " + ", ".join(row) + ",")
    lines.append("};")
    lines.append("")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
 
 
def main() -> int:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    csv_path    = os.path.join(root, "ml",      "dataset.csv")
    header_path = os.path.join(root, "include", "dht_anomaly_model.h")
    tflite_path = os.path.join(root, "ml",      "dht_risk_model.tflite")
 
    rng = np.random.default_rng(42)
    xs, ys, ys0 = build_dataset(rng)
    write_csv(csv_path, xs, ys)
    print(f"Wrote {csv_path} ({len(xs)} rows)")
 
    try:
        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
        os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
        import tensorflow as tf
        tf.get_logger().setLevel("ERROR")
    except ImportError:
        print("TensorFlow not installed. Run: pip install -r ml/requirements.txt", file=sys.stderr)
        return 1
 
    n = len(xs)
    idx = rng.permutation(n)
    split = int(n * 0.85)
    tr, va = idx[:split], idx[split:]
 
    model = tf.keras.Sequential(
        [
            tf.keras.layers.Input(shape=(3,)),
            tf.keras.layers.Dense(32, activation="relu"),
            tf.keras.layers.Dense(16, activation="relu"),
            tf.keras.layers.Dense(3,  activation="softmax"),
        ]
    )
    model.compile(
        optimizer=tf.keras.optimizers.Adam(0.002),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    early = tf.keras.callbacks.EarlyStopping(
        monitor="val_accuracy",
        mode="max",
        patience=15,
        restore_best_weights=True,
        verbose=1,
    )
 
    loss_before, acc_before = model.evaluate(xs[va], ys0[va], verbose=0)
    print(f"Accuracy before training: val_accuracy={acc_before:.4f}, val_loss={loss_before:.4f}")
 
    model.fit(
        xs[tr], ys0[tr],
        validation_data=(xs[va], ys0[va]),
        epochs=80,
        batch_size=64,
        verbose=1,
        callbacks=[early],
    )
 
    loss_after, acc_after = model.evaluate(xs[va], ys0[va], verbose=0)
    print(f"Accuracy after training: val_accuracy={acc_after:.4f}, val_loss={loss_after:.4f}")
 
    import logging
    logging.getLogger("absl").setLevel(logging.ERROR)
 
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    converter.optimizations = []
    with open(os.devnull, "w") as f, contextlib.redirect_stdout(f):
        tflite_model = converter.convert()
 
    with open(tflite_path, "wb") as f:
        f.write(tflite_model)
    print(f"Wrote {tflite_path} ({len(tflite_model)} bytes)")
 
    tflite_to_header(tflite_model, header_path)
    print(f"Wrote {header_path}")
    return 0
 
 
if __name__ == "__main__":
    raise SystemExit(main())