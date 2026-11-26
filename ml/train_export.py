"""Train and export a full-INT8 classifier of the DHT20 band 30 seconds ahead.

Executed offline/locally in a Python 3.12 venv on the Linux Ubuntu VM (never deployed
to Docker or Cloudflare) to train synthetic or imported session datasets, qualify INT8
quantization, and emit static C headers compiled into on-device ESP32-S3 firmware.
"""
from __future__ import annotations

import argparse
import contextlib
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import platform
import re
import sys

import numpy as np

from int8_export import invoke_int8_tflite, evaluate_scenarios
from trend_features import (
    LABELS, FEATURE_NAMES, FEATURE_CLIP, FEATURE_SCALES, PROFILE, T_MIN, T_MAX, H_MIN, H_MAX,
    REF_T_ON, REF_T_OFF, REF_H_ON, REF_H_OFF, WINDOW_SIZE, MAX_STEP_GAP_MS, HORIZON_SECONDS,
    extract_window_features, scale_features, band_label,
)

DEFAULT_VERSION = "fan-trend-int8-v2"


def artifact_version(requested: str, digest: str) -> str:
    base = re.sub(r"-[0-9a-fA-F]{12}$", "", requested)
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,51}", base):
        raise ValueError("model-version base must have 1 to 51 ASCII letters, digits, dots, underscores or hyphens")
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("model digest must be a lowercase SHA256 hex string")
    return f"{base}-{digest[:12]}"


def build_dataset(seed: int, count: int):
    """Generate an independent episode for every past/future example.

    Future observations are generated on the same trajectory as past readings.
    Only t <= 0 enters the network. The label is the measured band at t = +30 s.
    """
    rng = np.random.default_rng(seed)
    # Minutes, relative to the decision at t=0. Independent acquisition jitter per episode.
    past = np.column_stack((np.zeros(count), np.cumsum(rng.uniform(4.8, 5.2, (count, WINDOW_SIZE - 1)), axis=1)))
    past -= past[:, -1:]
    time = np.column_stack((past, np.tile(np.arange(5, HORIZON_SECONDS + 1, 5), (count, 1))))[:, :, None] / 60
    shape = (count, 1, 2)
    regime = rng.choice(4, size=(count, 1, 1), p=[.22, .40, .23, .15])
    # Temperatures and humidities are generated in hysteresis-band units.
    base = rng.uniform(-1.8, 1.9, shape)
    rate = rng.uniform(-3.8, 3.8, shape)
    linear = rate * time
    steady = rng.uniform(-.16, .16, shape) * time
    # A smooth peak can change direction in the observed window or in the future.
    center = rng.uniform(-.4, .4, shape)
    width = rng.uniform(.16, .42, shape)
    pulse = rng.uniform(-2.4, 2.4, shape) * np.exp(-.5 * ((time - center) / width) ** 2)
    # A brief isolated disturbance generally decays before the forecast time.
    impulse = rng.uniform(-1.0, 1.0, shape) * np.exp(-.5 * ((time - rng.uniform(-.5, .2, shape)) / .055) ** 2)
    travel = np.select([regime == 0, regime == 1, regime == 2], [steady, linear, pulse], default=steady + impulse)
    fan_on = rng.integers(0, 2, count).astype(bool)
    # Explicit simulator assumption: the command at the decision persists for the
    # horizon and weakly reduces exposure. Effects vary between independent episodes.
    response = fan_on[:, None, None] * rng.uniform(0, .7, shape) * np.maximum(time, 0)
    noise = rng.normal(size=travel.shape) * rng.uniform(.006, .06, shape)
    values = (base + travel - response + noise) * [2., 5.] + [REF_T_OFF, REF_H_OFF]
    values = np.clip(values, [T_MIN, H_MIN], [T_MAX, H_MAX]).round(3)
    raw = np.vstack([extract_window_features(v[:WINDOW_SIZE, 0], v[:WINDOW_SIZE, 1], t, f)
                     for v, t, f in zip(values, past, fan_on)])
    future = values[:, -1, :]
    labels = band_label(future[:, 0], future[:, 1])
    sessions = np.array([f"sim-{i:06d}" for i in range(count)])
    centered = past - past.mean(axis=1, keepdims=True)
    history = values[:, :WINDOW_SIZE, :]
    slopes = np.sum(centered[:, :, None] * history, axis=1) / np.sum(centered**2, axis=1, keepdims=True) * 60.
    observations = np.column_stack((history[:, -1, :], slopes, future))
    return raw, labels, sessions, observations


OBSERVATION_COLUMNS = ("temperature", "humidity", "temp_slope_c_min", "humi_slope_pct_min",
                       "future_temperature_c", "future_humidity_percent")


def load_csv(path: Path, label_source: str):
    rows, labels, sessions, observations = [], [], [], []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        required = set(FEATURE_NAMES) | set(OBSERVATION_COLUMNS[:4]) | {"label", "session_id"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError(f"CSV requires columns {sorted(required)}")
        for line, row in enumerate(reader, 2):
            try:
                feats = np.array([float(row[name]) for name in FEATURE_NAMES], dtype=np.float32)
                if not np.isfinite(feats).all():
                    raise ValueError("nonfinite feature value")
                if np.any(np.abs(feats[:6]) > FEATURE_CLIP + 1e-4) or not (0.0 <= feats[6] <= FEATURE_CLIP + 1e-4):
                    raise ValueError("feature out of [-4, 4] bounds")
                if feats[7] not in (0.0, 1.0):
                    raise ValueError("fan_on_at_sample must be 0 or 1")
                label = LABELS.index(row["label"].strip().upper())
                obs = [float(row[key]) for key in OBSERVATION_COLUMNS[:4]]
                if not np.isfinite(obs).all():
                    raise ValueError("nonfinite baseline observation")
                if label_source in ("observed-future", "simulated-future"):
                    future = [float(row[key]) for key in OBSERVATION_COLUMNS[4:]]
                    if not np.isfinite(future).all() or label != int(band_label(*future)):
                        raise ValueError("+30 s observation disagrees with the supplied outcome label")
                else:
                    future = [float("nan")] * 2
                session = row["session_id"].strip()
                recorded_source = row.get("label_source", label_source).strip()
                if recorded_source != label_source:
                    raise ValueError("label_source column disagrees with --label-source")
                if not session or len(session) > 512:
                    raise ValueError("session_id must have 1 to 512 characters")
            except (ValueError, TypeError, KeyError, AttributeError) as error:
                raise ValueError(f"CSV line {line}: {error}") from error
            rows.append(feats)
            labels.append(label)
            observations.append(obs + future)
            sessions.append(session)
    if len(rows) < 30:
        raise ValueError("At least 30 labeled window samples are required")
    return np.vstack(rows).astype(np.float32), np.array(labels, np.int32), np.array(sessions), np.array(observations)


def split_indices(ys: np.ndarray, sessions: np.ndarray, seed: int):
    rng = np.random.default_rng(seed + 1)
    groups = np.unique(sessions)
    if len(groups) < 3:
        raise ValueError("At least three independent sessions are required")
    groups = groups[rng.permutation(len(groups))]
    n_holdout = max(1, int(len(groups) * .15))
    group_parts = (groups[2*n_holdout:], groups[n_holdout:2*n_holdout], groups[:n_holdout])
    parts = {name: np.flatnonzero(np.isin(sessions, group))
             for name, group in zip(("train", "validation", "test"), group_parts)}
    for name, indices in parts.items():
        if len(indices) == 0 or set(ys[indices]) != set(range(len(LABELS))):
            raise ValueError(f"{name} needs all OFF/HOLD/ON classes; collect richer independent sessions")
    return parts


def dataset_csv(xs, ys, sessions, observations, parts, label_source) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow([*FEATURE_NAMES, *OBSERVATION_COLUMNS, "label", "session_id", "split", "label_source"])
    for split, indices in parts.items():
        for index in indices:
            writer.writerow(
                [*(f"{v:.9g}" for v in xs[index]),
                 *(repr(float(v)) if np.isfinite(v) else "" for v in observations[index]),
                 LABELS[ys[index]], sessions[index], split, label_source]
            )
    return output.getvalue().encode("utf-8")


def classification_metrics(truth: np.ndarray, predicted: np.ndarray) -> dict:
    confusion = np.zeros((3, 3), dtype=np.int64)
    np.add.at(confusion, (truth, predicted), 1)
    support = confusion.sum(axis=1)
    recall = np.divide(confusion.diagonal(), support, out=np.zeros(3, float), where=support != 0)
    return {
        "samples": int(len(truth)),
        "accuracy": float(np.mean(truth == predicted)),
        "confusion_matrix_true_rows_predicted_columns": confusion.tolist(),
        "recall": dict(zip(LABELS, map(float, recall))),
        "support": dict(zip(LABELS, map(int, support))),
    }


def gated_metrics(truth: np.ndarray, probabilities: np.ndarray, threshold: float = 0.8) -> dict:
    accepted = probabilities.max(axis=1) >= threshold
    errors = probabilities.argmax(axis=1) != truth
    accepted_count = int(accepted.sum())
    accepted_errors = int(np.count_nonzero(accepted & errors))
    return {
        "minimum_max_softmax": threshold,
        "samples": int(len(truth)),
        "accepted_samples": accepted_count,
        "coverage": float(accepted.mean()),
        "accepted_errors": accepted_errors,
        "accepted_accuracy": 1.0 - accepted_errors / accepted_count if accepted_count else None,
        "interpretation": "Dequantized INT8 softmax gate; window warmup, domain, and profile gates are enforced separately.",
    }


def early_start_metrics(truth, scores, static, fan):
    # The supervisor allows an early start only inside the hysteresis band,
    # with the command OFF. The dwell age is unknown for single-decision episodes.
    eligible = (static == LABELS.index("HOLD")) & (fan == 0)
    future_on = eligible & (truth == LABELS.index("ON"))
    proposed = eligible & (scores[:, LABELS.index("ON")] >= .80)
    tp = int(np.count_nonzero(proposed & future_on))
    fp = int(np.count_nonzero(proposed & ~future_on))
    fn = int(np.count_nonzero(future_on & ~proposed))
    return {
        "eligible_static_hold_and_command_off": int(eligible.sum()),
        "eligible_future_on": int(future_on.sum()),
        "true_positives": tp, "false_positives": fp, "false_negatives": fn,
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "dwell": "Unknown in single-decision episodes. Counts measure candidate starts before the ten-second dwell gate.",
    }


def model_header(content: bytes) -> str:
    lines = [
        "#pragma once",
        "",
        "// Generated by ml/train_export.py; see ml/models/fan_model_manifest.json.",
        "alignas(16) const unsigned char fan_model_tflite[] = {",
    ]
    for start in range(0, len(content), 12):
        lines.append("    " + ", ".join(f"0x{byte:02x}" for byte in content[start:start + 12]) + ",")
    lines.append("};")
    lines.append(f"constexpr unsigned int fan_model_tflite_len = {len(content)}U;")
    lines.append("")
    return "\n".join(lines)


def metadata_header(version: str, digest: str) -> str:
    lines = [
        "#pragma once",
        "",
        "#include <stdint.h>",
        "",
        "// Generated INT8 sliding-window trend model metadata.",
        "namespace fan_model {",
        f'constexpr const char *MODEL_VERSION = "{version}";',
        f'constexpr const char *MODEL_SHA256 = "{digest}";',
        f'constexpr const char *PROFILE = "{PROFILE}";',
        f"constexpr uint8_t FEATURE_COUNT = {len(FEATURE_NAMES)}U;",
        f"constexpr uint8_t WINDOW_SIZE = {WINDOW_SIZE}U;",
        f"constexpr uint8_t MIN_WINDOW_SAMPLES = {WINDOW_SIZE}U;",
        f"constexpr uint32_t MAX_STEP_GAP_MS = {MAX_STEP_GAP_MS}U;",
        f"constexpr uint8_t HORIZON_SECONDS = {HORIZON_SECONDS}U;",
        f"constexpr float FEATURE_CLIP = {FEATURE_CLIP:.1f}f;",
        f"constexpr float T_MIN = {T_MIN:.1f}f;",
        f"constexpr float T_MAX = {T_MAX:.1f}f;",
        f"constexpr float H_MIN = {H_MIN:.1f}f;",
        f"constexpr float H_MAX = {H_MAX:.1f}f;",
        f"constexpr float REF_T_ON = {REF_T_ON:.1f}f;",
        f"constexpr float REF_T_OFF = {REF_T_OFF:.1f}f;",
        f"constexpr float REF_H_ON = {REF_H_ON:.1f}f;",
        f"constexpr float REF_H_OFF = {REF_H_OFF:.1f}f;",
        "} // namespace fan_model",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--epochs", type=int, default=70)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--synthetic-samples", type=int, default=24000, help="Number of independent synthetic episodes")
    parser.add_argument("--csv", type=Path, help="Window feature CSV from ml/import_history.py")
    parser.add_argument("--label-source", choices=("operator", "observed-future", "simulated-future"), help="Required with --csv")
    parser.add_argument("--model-version", default=DEFAULT_VERSION)
    args = parser.parse_args()

    if args.epochs < 1 or args.synthetic_samples < 300 or not 0 <= args.seed < 2**31:
        parser.error("epochs >= 1, synthetic-samples >= 300, and 0 <= seed < 2^31 are required")
    if bool(args.csv) != bool(args.label_source):
        parser.error("--csv and --label-source must be provided together")
    try:
        artifact_version(args.model_version, "0" * 64)
    except ValueError as error:
        parser.error(str(error))

    label_source = args.label_source or "simulated-future"
    xs_raw, ys, sessions, observations = load_csv(args.csv, label_source) if args.csv else build_dataset(args.seed, args.synthetic_samples)
    parts = split_indices(ys, sessions, args.seed)
    csv_content = dataset_csv(xs_raw, ys, sessions, observations, parts, label_source)
    xs_scaled = scale_features(xs_raw)

    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "-1")
    import tensorflow as tf

    tf.get_logger().setLevel("ERROR")
    tf.config.threading.set_inter_op_parallelism_threads(1)
    tf.config.threading.set_intra_op_parallelism_threads(1)
    tf.keras.utils.set_random_seed(args.seed)
    tf.config.experimental.enable_op_determinism()

    steps_per_epoch = math.ceil(len(parts["train"]) / 128)
    lr_schedule = tf.keras.optimizers.schedules.CosineDecay(
        initial_learning_rate=0.003,
        decay_steps=max(1, args.epochs * steps_per_epoch),
        alpha=0.03,
    )
    model = tf.keras.Sequential(
        [
            tf.keras.layers.Input(shape=(len(FEATURE_NAMES),), batch_size=1),
            tf.keras.layers.Dense(64, activation="relu"),
            tf.keras.layers.Dense(32, activation="relu"),
            tf.keras.layers.Dense(3, activation="softmax"),
        ]
    )
    model.compile(
        optimizer=tf.keras.optimizers.Adam(lr_schedule),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    options = tf.data.Options()
    options.threading.private_threadpool_size = 1
    options.threading.max_intra_op_parallelism = 1

    def make_dataset(indices: np.ndarray, shuffle: bool = False):
        ds = tf.data.Dataset.from_tensor_slices((xs_scaled[indices], ys[indices]))
        if shuffle:
            ds = ds.shuffle(len(indices), seed=args.seed, reshuffle_each_iteration=True)
        return ds.batch(128).with_options(options)

    callback = tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=25, restore_best_weights=True)
    history = model.fit(
        make_dataset(parts["train"], True),
        validation_data=make_dataset(parts["validation"]),
        epochs=args.epochs,
        callbacks=[callback],
        shuffle=False,
        verbose=2,
    )

    # Representative dataset uses ONLY training samples so validation/test never leak into quantization scales.
    cal_rng = np.random.default_rng(args.seed + 7)
    train_idx = parts["train"]
    cal_indices = train_idx[cal_rng.choice(len(train_idx), size=min(1024, len(train_idx)), replace=False)]

    def representative_dataset():
        for idx in cal_indices:
            yield [xs_scaled[idx : idx + 1]]


    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    converter._experimental_disable_per_channel = True  # Vendored FC kernel has a scalar multiplier
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    converter.representative_dataset = representative_dataset
    converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    converter.inference_input_type = tf.int8
    converter.inference_output_type = tf.int8
    with open(os.devnull, "w") as silence, contextlib.redirect_stdout(silence):
        content = converter.convert()

    heldout = np.concatenate((parts["validation"], parts["test"]))
    float_probs = model(xs_scaled[heldout], training=False).numpy()
    int8_probs, conversion = invoke_int8_tflite(tf, content, xs_scaled[heldout])

    int8_vs_float_agreement = float(np.mean(int8_probs.argmax(axis=1) == float_probs.argmax(axis=1)))
    conversion["heldout_samples"] = int(len(heldout))
    conversion["int8_vs_float32_class_agreement"] = int8_vs_float_agreement
    conversion["mean_probability_abs_diff"] = float(np.mean(np.abs(int8_probs - float_probs)))
    conversion["max_probability_abs_diff"] = float(np.max(np.abs(int8_probs - float_probs)))
    # Gate on validation loss of forecast accuracy after conversion. Float/INT8
    # ties near class boundaries can differ while having similar accuracy.
    n_val = len(parts["validation"])
    val_truth = ys[parts["validation"]]
    float_val_accuracy = float(np.mean(float_probs[:n_val].argmax(axis=1) == val_truth))
    int8_val_accuracy = float(np.mean(int8_probs[:n_val].argmax(axis=1) == val_truth))
    conversion["float_validation_accuracy"] = float_val_accuracy
    conversion["int8_validation_accuracy"] = int8_val_accuracy
    if float_val_accuracy - int8_val_accuracy > .01:
        raise ValueError("INT8 lost over one percentage point of validation accuracy")

    scenario_report = evaluate_scenarios(tf, content)
    digest = hashlib.sha256(content).hexdigest()
    version = artifact_version(args.model_version, digest)
    majority = int(np.argmax(np.bincount(ys[parts["train"]], minlength=3)))

    results, cursor = {}, 0
    for name in ("validation", "test"):
        indices = parts[name]
        split_probs = int8_probs[cursor : cursor + len(indices)]
        predictions = split_probs.argmax(axis=1)
        cursor += len(indices)
        temp, humi, slope_t, slope_h = observations[indices, :4].T
        static_preds = band_label(temp, humi)
        linear_preds = band_label(temp + slope_t * HORIZON_SECONDS / 60,
                                  humi + slope_h * HORIZON_SECONDS / 60)
        pre_threshold = static_preds != 2
        early_on = (predictions == 2) & (split_probs[:, 2] >= .80) & pre_threshold
        results[name] = {
            "int8_model": classification_metrics(ys[indices], predictions),
            "softmax_gate": gated_metrics(ys[indices], split_probs),
            "static_threshold_baseline": classification_metrics(ys[indices], static_preds),
            "ols_extrapolation_baseline": classification_metrics(ys[indices], linear_preds),
            "eligible_early_start_gate_080": early_start_metrics(ys[indices], split_probs, static_preds, xs_raw[indices, -1]),
            "early_on_forecasts_gate_080": {
                "proposed": int(early_on.sum()), "correct_future_on": int(np.sum(early_on & (ys[indices] == 2))),
                "future_on_below_threshold": int(np.sum(pre_threshold & (ys[indices] == 2))),
            },
            "train_majority_baseline": classification_metrics(ys[indices], np.full(len(indices), majority)),
        }

    manifest = {
        "schema_version": 2,
        "hardware_validated": False,
        "real_environment_efficacy_validated": False,
        "model_version": version,
        "profile": PROFILE,
        "sha256": digest,
        "bytes": len(content),
        "labels_by_index": list(LABELS),
        "purpose": "forecast OFF/HOLD/ON threshold region at +30 s under a sustained command",
        "label_source": label_source,
        "data_origin": "recorded-window-csv" if args.csv else "synthetic-multi-regime-trajectories",
        "window": {
            "capacity_samples": WINDOW_SIZE,
            "minimum_warmup_samples": WINDOW_SIZE,
            "nominal_sample_period_s": 5.0,
            "max_step_gap_ms": MAX_STEP_GAP_MS,
            "forecast_horizon_seconds": HORIZON_SECONDS,
            "features": list(FEATURE_NAMES),
            "feature_clip": FEATURE_CLIP,
            "pre_quantization_divisors": FEATURE_SCALES.tolist(),
        },
        "domain": {
            "temperature_c": [T_MIN, T_MAX],
            "humidity_percent": [H_MIN, H_MAX],
            "reference_thresholds_on_off": {"temperature_c": [REF_T_ON, REF_T_OFF], "humidity_pct": [REF_H_ON, REF_H_OFF]},
            "activation_logic": "any",
        },
        "seed": args.seed,
        "requested_epochs": args.epochs,
        "completed_epochs": len(history.history["loss"]),
        "best_epoch_by_validation_loss": int(np.argmin(history.history["val_loss"])) + 1,
        "architecture": [len(FEATURE_NAMES), 64, 32, 3],
        "quantization": "post-training full-integer INT8 (int8 inputs, int8 weights, int32 biases, int8 outputs)",
        "training": {
            "optimizer": "Adam",
            "learning_rate": "CosineDecay(0.003, alpha=0.03)",
            "batch_size": 128,
            "early_stopping": {"monitor": "val_loss", "patience": 25, "restore_best_weights": True},
            "deterministic_ops": True,
            "threads": 1,
            "cpu_only": True,
        },
        "dataset": {
            "sha256": hashlib.sha256(csv_content).hexdigest(),
            "rows": int(len(xs_raw)),
            "split_method": "session-disjoint",
            "split_sizes": {name: int(len(indices)) for name, indices in parts.items()},
            "split_session_counts": {name: len(np.unique(sessions[indices])) for name, indices in parts.items()},
            "split_sessions": {name: sorted(set(sessions[indices])) for name, indices in parts.items()} if args.csv and len(set(sessions)) < 1000 else None,
            "input_file_sha256": hashlib.sha256(args.csv.read_bytes()).hexdigest() if args.csv else None,
        },
        "metrics": results,
        "conversion": conversion,
        "scenario_verification": scenario_report,
        "environment": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "tensorflow": tf.__version__,
            "keras": tf.keras.__version__,
        },
        "limitations": [
            "Default training and evaluation use synthetic trajectories and assumed fan response. Real efficacy needs held-out physical sessions.",
            "The forecast predicts the threshold band at +30 seconds; disturbances between now and that time may change the outcome.",
            "INT8 softmax scores are dequantized to multiples of 1/256. Threshold 0.80 is a control gate, not a calibrated probability.",
        ],
    }

    artifacts = {
        "ml/data/dataset.csv": csv_content,
        "ml/models/dht_fan_model.tflite": content,
        "ml/models/fan_model_manifest.json": (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode(),
        "firmware/include/dht_fan_model.h": model_header(content).encode(),
        "firmware/include/fan_model_metadata.h": metadata_header(version, digest).encode(),
    }
    for relative, value in artifacts.items():
        path = args.output_dir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_bytes(value)
        temporary.replace(path)

    print(
        json.dumps(
            {
                "model_version": version,
                "bytes": len(content),
                "sha256": digest,
                "test": results["test"],
                "scenarios_passed": list(scenario_report.keys()),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, ImportError, OSError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
