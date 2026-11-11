from __future__ import annotations

import argparse
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


def final_label(t: float, h: float) -> int:
    # Synthetic air-risk labels, with normalized temperature/humidity ratio 7:4.
    r = (7.0 * _score_temperature(t) + 4.0 * _score_humidity(h)) / 11.0
    if r <= 3.0:
        return 1
    if r <= 6.5:
        return 2
    return 3


def build_dataset(
    rng: np.random.Generator, n_extra: int = 5000
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rows: list[tuple[float, float]] = []

    def add_sample(t: float, h: float) -> None:
        # Train on exactly the precision exported to CSV, keeping all readings
        # inside the documented synthetic training domain.
        rows.append((round(float(np.clip(t, 5.0, 50.0)), 4),
                     round(float(np.clip(h, 20.0, 100.0)), 4)))

    # 16,000 jittered grid samples plus 5,000 random samples by default.
    for t in np.linspace(5.0, 50.0, 80):
        for h in np.linspace(20.0, 100.0, 100):
            for _ in range(2):
                add_sample(t + rng.normal(0, 0.2), h + rng.normal(0, 0.3))

    for _ in range(n_extra):
        tt = float(rng.uniform(5.0, 50.0))
        hh = float(rng.uniform(20.0, 100.0))
        add_sample(tt, hh)

    xs = np.array(rows, dtype=np.float32)
    ys = np.array([final_label(float(t), float(h)) for t, h in xs], dtype=np.int32)
    ys0 = ys - 1
    return xs, ys, ys0


def write_csv(path: str, xs: np.ndarray, ys: np.ndarray) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["temperature", "humidity", "final_label"])
        for (t, h), lab in zip(xs, ys):
            w.writerow([f"{t:.4f}", f"{h:.4f}", int(lab)])


def tflite_to_header(tflite_bytes: bytes, out_path: str) -> None:
    lines = ["#pragma once", "", "alignas(16) const unsigned char dht_anomaly_model_tflite[] = {"]
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


def validate_tflite_model(tf, model, tflite_model: bytes, samples: np.ndarray) -> None:
    # TensorFlowLite_ESP32 1.0.0 supports these float32 v1 operators.
    # Reject newer converter output before replacing a working firmware model.
    from tensorflow.lite.python import schema_py_generated as schema

    flat_model = schema.Model.GetRootAsModel(tflite_model, 0)
    if flat_model.Version() != 3:
        raise ValueError("Unsupported TFLite model schema")
    allowed = {schema.BuiltinOperator.FULLY_CONNECTED, schema.BuiltinOperator.SOFTMAX}
    for i in range(flat_model.OperatorCodesLength()):
        op = flat_model.OperatorCodes(i)
        if op.BuiltinCode() not in allowed or op.Version() != 1:
            raise ValueError(f"Unsupported TinyML operator: {op.BuiltinCode()} v{op.Version()}")

    interpreter = tf.lite.Interpreter(model_content=tflite_model)
    interpreter.allocate_tensors()
    input_info = interpreter.get_input_details()[0]
    output_info = interpreter.get_output_details()[0]
    if (tuple(input_info["shape"]) != (1, 2)
            or tuple(output_info["shape"]) != (1, 3)
            or input_info["dtype"] != np.float32
            or output_info["dtype"] != np.float32):
        raise ValueError("TinyML requires float32 input (1, 2) and output (1, 3)")
    expected = model(samples, training=False).numpy()
    for sample, prediction in zip(samples, expected):
        interpreter.set_tensor(input_info["index"], sample.reshape(1, 2))
        interpreter.invoke()
        actual = interpreter.get_tensor(output_info["index"])[0]
        np.testing.assert_allclose(actual, prediction, rtol=1e-4, atol=1e-5)
    print(f"Validated TFLite operators and {len(samples)} predictions")


def main() -> int:
    parser = argparse.ArgumentParser(description="Train and validate the ESP32 TinyML model")
    parser.add_argument("--output-dir", default=os.path.join(os.path.dirname(__file__), ".."),
                        help="Project root for generated ml/ and firmware/include/ files")
    parser.add_argument("--epochs", type=int, default=80)
    args = parser.parse_args()
    if args.epochs < 1:
        parser.error("--epochs must be positive")
    root = os.path.abspath(args.output_dir)
    csv_path    = os.path.join(root, "ml", "data", "dataset.csv")
    header_path = os.path.join(root, "firmware", "include", "dht_risk_model.h")
    tflite_path = os.path.join(root, "ml", "models", "dht_risk_model.tflite")

    rng = np.random.default_rng(42)
    xs, ys, ys0 = build_dataset(rng)

    try:
        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
        os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
        import tensorflow as tf
        tf.get_logger().setLevel("ERROR")
    except ImportError:
        print("TensorFlow not installed. Run: pip install -r ml/requirements.txt", file=sys.stderr)
        return 1

    tf.keras.utils.set_random_seed(42)
    n = len(xs)
    idx = rng.permutation(n)
    split = int(n * 0.85)
    tr, va = idx[:split], idx[split:]
    input_offset = np.array([27.5, 60.0], dtype=np.float32)
    input_scale = np.array([22.5, 40.0], dtype=np.float32)
    normalized_xs = (xs - input_offset) / input_scale

    model = tf.keras.Sequential(
        [
            tf.keras.layers.Input(shape=(2,)),
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

    # Explicit small thread pools also support CPU-only development hosts.
    options = tf.data.Options()
    options.threading.private_threadpool_size = 1
    options.threading.max_intra_op_parallelism = 1
    train_data = (tf.data.Dataset.from_tensor_slices((normalized_xs[tr], ys0[tr]))
                  .shuffle(len(tr), seed=42).batch(64).with_options(options))
    validation_data = (tf.data.Dataset.from_tensor_slices((normalized_xs[va], ys0[va]))
                       .batch(64).with_options(options))

    loss_before, acc_before = model.evaluate(validation_data, verbose=0)
    print(f"Accuracy before training: val_accuracy={acc_before:.4f}, val_loss={loss_before:.4f}")

    model.fit(
        train_data,
        validation_data=validation_data,
        epochs=args.epochs,
        verbose=2,
        callbacks=[early],
    )

    loss_after, acc_after = model.evaluate(validation_data, verbose=0)
    print(f"Accuracy after training: val_accuracy={acc_after:.4f}, val_loss={loss_after:.4f}")

    # Fold training normalization into the first Dense layer. The deployed model
    # accepts raw Celsius/%RH and still uses only fully-connected/softmax ops.
    normalized_predictions = model(normalized_xs[va], training=False).numpy()
    weights, bias = model.layers[0].get_weights()
    model.layers[0].set_weights([
        weights / input_scale[:, None],
        bias - (input_offset / input_scale) @ weights,
    ])
    np.testing.assert_allclose(model(xs[va], training=False).numpy(),
                               normalized_predictions, rtol=1e-4, atol=1e-5)
    print(f"Validated folded normalization on {len(va)} validation samples")

    import logging
    logging.getLogger("absl").setLevel(logging.ERROR)

    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    converter.optimizations = []
    converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS]
    with open(os.devnull, "w") as f, contextlib.redirect_stdout(f):
        tflite_model = converter.convert()

    validate_tflite_model(tf, model, tflite_model, xs[va[:32]])

    write_csv(csv_path, xs, ys)
    print(f"Wrote {csv_path} ({len(xs)} rows)")
    os.makedirs(os.path.dirname(header_path), exist_ok=True)
    os.makedirs(os.path.dirname(tflite_path), exist_ok=True)
    with open(tflite_path, "wb") as f:
        f.write(tflite_model)
    print(f"Wrote {tflite_path} ({len(tflite_model)} bytes)")

    tflite_to_header(tflite_model, header_path)
    print(f"Wrote {header_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
