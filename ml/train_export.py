"""Reproducible lab fan-policy imitation; this does not establish cooling efficacy.

Synthetic samples teach OFF/HOLD/ON for a fixed, versioned hysteresis profile.
Optional CSV labels must be explicitly identified as operator or synthetic-policy.
The test split never participates in model fitting or early stopping.
"""
from __future__ import annotations

import argparse
import contextlib
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import sys

import numpy as np

LABELS = ("OFF", "HOLD", "ON")
T_MIN, T_MAX, H_MIN, H_MAX = 5.0, 50.0, 20.0, 100.0
T_ON, T_OFF, H_ON, H_OFF = 30.0, 28.0, 75.0, 70.0
PROFILE = "lab-or-30-28-75-70-v1"
DEFAULT_VERSION = "fan-policy-v1"


def artifact_version(requested: str, digest: str) -> str:
    # A prior artifact suffix may be pasted back into --model-version. Replace it
    # instead of growing the ID on each retrain. Backend accepts at most 64 chars.
    base = re.sub(r"-[0-9a-fA-F]{12}$", "", requested)
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,51}", base):
        raise ValueError("model-version base must have 1 to 51 ASCII letters, digits, dots, underscores or hyphens")
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("model digest must be a lowercase SHA256 hex string")
    return f"{base}-{digest[:12]}"


def policy_label(temperature: float, humidity: float) -> int:
    if temperature >= T_ON or humidity >= H_ON:
        return 2
    if temperature <= T_OFF and humidity <= H_OFF:
        return 0
    return 1


def build_dataset(seed: int, count: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    # Independent continuous coordinates, rounded before labeling. Exact duplicate
    # inputs are removed before splitting so they cannot leak across partitions.
    rows = rng.uniform([T_MIN, H_MIN], [T_MAX, H_MAX], (count, 2))
    # Boundary examples are included in every partition by random assignment;
    # no held-out sample is copied into the training set.
    edge_count = max(100, count // 8)
    for axis, thresholds, other_min, other_max in (
        (0, (T_OFF, T_ON), H_MIN, H_MAX),
        (1, (H_OFF, H_ON), T_MIN, T_MAX),
    ):
        for threshold in thresholds:
            edge = np.empty((edge_count, 2), dtype=np.float64)
            edge[:, axis] = threshold + rng.uniform(-1.0, 1.0, edge_count)
            edge[:, 1 - axis] = rng.uniform(other_min, other_max, edge_count)
            rows = np.concatenate((rows, edge))
    xs = np.unique(np.round(rows, 4).astype(np.float32), axis=0)
    ys = np.array([policy_label(float(t), float(h)) for t, h in xs], dtype=np.int32)
    return xs, ys, np.full(len(xs), "synthetic", dtype=object)


def load_csv(path: Path, label_source: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rows, labels, sessions = [], [], []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        required = {"temperature", "humidity", "label", "session_id"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError(f"CSV requires columns {sorted(required)}")
        for line, row in enumerate(reader, 2):
            try:
                temperature, humidity = float(row["temperature"]), float(row["humidity"])
                label = LABELS.index(row["label"].strip().upper())
                session = row["session_id"].strip()
                recorded_source = row.get("label_source", label_source).strip()
                if recorded_source != label_source:
                    raise ValueError("label_source column disagrees with --label-source")
                if not session or len(session) > 512:
                    raise ValueError("session_id must have 1 to 512 characters")
                if not (T_MIN <= temperature <= T_MAX and H_MIN <= humidity <= H_MAX):
                    raise ValueError("nonfinite or out-of-domain temperature/humidity")
                # Canonical float32 values are the actual deployed input precision.
                temperature, humidity = map(float, np.array([temperature, humidity], np.float32))
                if label_source == "synthetic-policy" and label != policy_label(temperature, humidity):
                    raise ValueError("synthetic-policy label disagrees with the fixed teacher")
            except (ValueError, TypeError, KeyError, AttributeError) as error:
                raise ValueError(f"CSV line {line}: {error}") from error
            rows.append((temperature, humidity))
            labels.append(label)
            sessions.append(session)
    if len(rows) < 30:
        raise ValueError("At least 30 labeled samples are required")
    return np.array(rows, np.float32), np.array(labels, np.int32), np.array(sessions, dtype=object)


def split_indices(ys: np.ndarray, sessions: np.ndarray, seed: int,
                  group_sessions: bool) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed + 1)
    names = ("train", "validation", "test")
    if group_sessions:
        groups = np.array(sorted(set(sessions)), dtype=object)
        if len(groups) < 3:
            raise ValueError("Real/imported CSV needs at least three independent session_id values")
        groups = groups[rng.permutation(len(groups))]
        n_test = max(1, int(len(groups) * 0.15))
        n_validation = max(1, int(len(groups) * 0.15))
        group_parts = (groups[n_test + n_validation:], groups[n_test:n_test + n_validation], groups[:n_test])
        parts = {name: np.flatnonzero(np.isin(sessions, group))
                 for name, group in zip(names, group_parts)}
    else:
        # Stratification is only for independent synthetic samples, never time-series rows.
        bins = {name: [] for name in names}
        for label in range(len(LABELS)):
            indices = rng.permutation(np.flatnonzero(ys == label))
            n_test, n_validation = max(1, int(len(indices) * 0.15)), max(1, int(len(indices) * 0.15))
            for name, part in zip(names, (indices[n_test + n_validation:],
                                         indices[n_test:n_test + n_validation], indices[:n_test])):
                bins[name].extend(part.tolist())
        parts = {name: rng.permutation(np.array(indices, dtype=np.int64)) for name, indices in bins.items()}
    for name, indices in parts.items():
        if len(indices) == 0 or set(ys[indices]) != set(range(len(LABELS))):
            raise ValueError(f"{name} needs all OFF/HOLD/ON classes; collect richer independent sessions")
    return parts


def dataset_csv(xs, ys, sessions, parts, label_source: str) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(["temperature", "humidity", "label", "session_id", "split", "label_source"])
    for split, indices in parts.items():
        for index in indices:
            # Nine significant digits preserve float32 values on a CSV round trip.
            writer.writerow([f"{xs[index, 0]:.9g}", f"{xs[index, 1]:.9g}", LABELS[ys[index]],
                             sessions[index], split, label_source])
    return output.getvalue().encode("utf-8")


def classification_metrics(truth: np.ndarray, predicted: np.ndarray) -> dict:
    confusion = np.zeros((3, 3), dtype=np.int64)
    np.add.at(confusion, (truth, predicted), 1)
    support = confusion.sum(axis=1)
    recall = np.divide(confusion.diagonal(), support, out=np.zeros(3, float), where=support != 0)
    return {"samples": len(truth), "accuracy": float(np.mean(truth == predicted)),
            "confusion_matrix_true_rows_predicted_columns": confusion.tolist(),
            "recall": dict(zip(LABELS, map(float, recall))),
            "support": dict(zip(LABELS, map(int, support)))}


def gated_metrics(truth: np.ndarray, probabilities: np.ndarray, threshold: float = 0.8) -> dict:
    accepted = probabilities.max(axis=1) >= threshold
    errors = probabilities.argmax(axis=1) != truth
    accepted_count = int(accepted.sum())
    accepted_errors = int(np.count_nonzero(accepted & errors))
    return {"minimum_max_softmax": threshold, "samples": len(truth),
            "accepted_samples": accepted_count, "coverage": float(accepted.mean()),
            "accepted_errors": accepted_errors,
            "accepted_accuracy": 1.0 - accepted_errors / accepted_count if accepted_count else None,
            "interpretation": "Uncalibrated softmax gate only; profile/freshness/domain gates are separate."}


def validate_tflite_model(tf, model, content: bytes, samples: np.ndarray) -> tuple[np.ndarray, dict]:
    from tensorflow.lite.python import schema_py_generated as schema
    flat = schema.Model.GetRootAsModel(content, 0)
    if flat.Version() != 3 or flat.SubgraphsLength() != 1:
        raise ValueError("Unsupported TFLite schema/subgraphs")
    allowed = {schema.BuiltinOperator.FULLY_CONNECTED: "FULLY_CONNECTED", schema.BuiltinOperator.SOFTMAX: "SOFTMAX"}
    operators = []
    for index in range(flat.OperatorCodesLength()):
        op = flat.OperatorCodes(index)
        if op.BuiltinCode() not in allowed or op.Version() != 1:
            raise ValueError(f"Unsupported ESP32 operator {op.BuiltinCode()} version {op.Version()}")
        operators.append({"name": allowed[op.BuiltinCode()], "version": op.Version()})
    interpreter = tf.lite.Interpreter(model_content=content, num_threads=1)
    interpreter.allocate_tensors()
    inputs, outputs = interpreter.get_input_details(), interpreter.get_output_details()
    if len(inputs) != 1 or len(outputs) != 1:
        raise ValueError("Model requires exactly one input and one output tensor")
    inp, out = inputs[0], outputs[0]
    if tuple(inp["shape"]) != (1, 2) or tuple(out["shape"]) != (1, 3) or inp["dtype"] != np.float32 or out["dtype"] != np.float32:
        raise ValueError("Model requires float32 input (1,2) and output (1,3)")
    expected = model(samples, training=False).numpy()
    actual = np.empty_like(expected)
    for index, sample in enumerate(samples):
        interpreter.set_tensor(inp["index"], sample.reshape(1, 2))
        interpreter.invoke()
        actual[index] = interpreter.get_tensor(out["index"])[0]
    if not np.isfinite(actual).all() or (actual < 0).any() or (actual > 1).any():
        raise ValueError("Invalid softmax values")
    np.testing.assert_allclose(actual.sum(axis=1), 1.0, rtol=0, atol=1e-5)
    np.testing.assert_allclose(actual, expected, rtol=1e-4, atol=2e-5)
    disagreements = int(np.count_nonzero(actual.argmax(axis=1) != expected.argmax(axis=1)))
    if disagreements:
        raise ValueError(f"Keras/TFLite class disagreement on {disagreements} held-out samples")
    return actual, {"samples": len(samples), "max_probability_absolute_error": float(np.max(np.abs(actual - expected))),
                    "class_disagreements": disagreements, "operators": operators,
                    "input": {"shape": [1, 2], "dtype": "float32", "units": ["C", "%RH"]},
                    "output": {"shape": [1, 3], "dtype": "float32", "labels": list(LABELS)}}


def model_header(content: bytes) -> str:
    lines = ["#pragma once", "", "// Generated by ml/train_export.py; see ml/models/fan_model_manifest.json.",
             "alignas(16) const unsigned char fan_model_tflite[] = {"]
    for start in range(0, len(content), 12):
        lines.append("    " + ", ".join(f"0x{byte:02x}" for byte in content[start:start + 12]) + ",")
    return "\n".join(lines + ["};", ""])


def metadata_header(version: str, digest: str) -> str:
    lines = ["#pragma once", "", "// Generated lab policy metadata; probabilities are not calibrated confidence.",
             "namespace fan_model {", f'constexpr const char *MODEL_VERSION = "{version}";',
             f'constexpr const char *MODEL_SHA256 = "{digest}";', f'constexpr const char *PROFILE = "{PROFILE}";']
    for name in ("T_MIN", "T_MAX", "H_MIN", "H_MAX", "T_ON", "T_OFF", "H_ON", "H_OFF"):
        lines.append(f"constexpr float {name} = {globals()[name]:.1f}f;")
    return "\n".join(lines + ["} // namespace fan_model", ""])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--synthetic-samples", type=int, default=24000, help="Uniform samples; adds 50%% boundary samples")
    parser.add_argument("--csv", type=Path, help="temperature,humidity,label,session_id CSV; labels OFF/HOLD/ON")
    parser.add_argument("--label-source", choices=("operator", "synthetic-policy"), help="Required with --csv")
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
    label_source = args.label_source or "synthetic-policy"
    xs, ys, sessions = load_csv(args.csv, label_source) if args.csv else build_dataset(args.seed, args.synthetic_samples)
    parts = split_indices(ys, sessions, args.seed, group_sessions=bool(args.csv))
    csv_content = dataset_csv(xs, ys, sessions, parts, label_source)
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "-1")
    import tensorflow as tf
    tf.get_logger().setLevel("ERROR")
    tf.config.threading.set_inter_op_parallelism_threads(1)
    tf.config.threading.set_intra_op_parallelism_threads(1)
    tf.keras.utils.set_random_seed(args.seed)
    tf.config.experimental.enable_op_determinism()
    offset, scale = np.array([27.5, 60.0], np.float32), np.array([22.5, 40.0], np.float32)
    normalized = (xs - offset) / scale
    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(2,), batch_size=1),
        tf.keras.layers.Dense(32, activation="relu"),
        tf.keras.layers.Dense(16, activation="relu"),
        tf.keras.layers.Dense(3, activation="softmax"),
    ])
    model.compile(optimizer=tf.keras.optimizers.Adam(0.002), loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    options = tf.data.Options()
    options.threading.private_threadpool_size = 1
    options.threading.max_intra_op_parallelism = 1
    def data(indices, shuffle=False):
        result = tf.data.Dataset.from_tensor_slices((normalized[indices], ys[indices]))
        if shuffle:
            result = result.shuffle(len(indices), seed=args.seed, reshuffle_each_iteration=True)
        return result.batch(128).with_options(options)
    callback = tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=18, restore_best_weights=True)
    history = model.fit(data(parts["train"], True), validation_data=data(parts["validation"]),
                        epochs=args.epochs, callbacks=[callback], verbose=2)
    heldout = np.concatenate((parts["validation"], parts["test"]))
    normalized_predictions = model(normalized[heldout], training=False).numpy()
    weights, bias = model.layers[0].get_weights()
    model.layers[0].set_weights([weights / scale[:, None], bias - (offset / scale) @ weights])
    np.testing.assert_allclose(model(xs[heldout], training=False).numpy(), normalized_predictions, rtol=1e-4, atol=2e-5)
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    converter.optimizations = []
    converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS]
    with open(os.devnull, "w") as silence, contextlib.redirect_stdout(silence):
        content = converter.convert()
    probabilities, conversion = validate_tflite_model(tf, model, content, xs[heldout])
    digest = hashlib.sha256(content).hexdigest()
    version = artifact_version(args.model_version, digest)
    majority = int(np.argmax(np.bincount(ys[parts["train"]], minlength=3)))
    results, cursor = {}, 0
    for name in ("validation", "test"):
        indices = parts[name]
        split_probabilities = probabilities[cursor:cursor + len(indices)]
        predictions = split_probabilities.argmax(axis=1)
        cursor += len(indices)
        results[name] = {
            "model": classification_metrics(ys[indices], predictions),
            "softmax_gate": gated_metrics(ys[indices], split_probabilities),
            "fixed_policy_baseline": classification_metrics(ys[indices], np.array([policy_label(float(t), float(h)) for t, h in xs[indices]])),
            "train_majority_baseline": classification_metrics(ys[indices], np.full(len(indices), majority)),
        }
    boundaries = np.array([(t, h) for t in (T_OFF - .01, T_OFF, T_OFF + .01, T_ON - .01, T_ON, T_ON + .01)
                           for h in (H_OFF - .01, H_OFF, H_OFF + .01, H_ON - .01, H_ON, H_ON + .01)], np.float32)
    boundary_probs, boundary_conversion = validate_tflite_model(tf, model, content, boundaries)
    boundary_truth = np.array([policy_label(float(t), float(h)) for t, h in boundaries])
    manifest = {
        "schema_version": 1, "model_version": version, "profile": PROFILE,
        "sha256": digest, "bytes": len(content), "labels_by_index": list(LABELS),
        "purpose": "lab fan action policy imitation", "label_source": label_source,
        "data_origin": "recorded-csv" if args.csv else "synthetic",
        "claims": {"real_environment_efficacy_validated": False, "hardware_validated": False,
                   "probabilities_calibrated": False, "forecasting": False},
        "domain": {"temperature_c": [T_MIN, T_MAX], "humidity_percent": [H_MIN, H_MAX]},
        "teacher": {"on": "temperature >= 30 OR humidity >= 75", "off": "temperature <= 28 AND humidity <= 70",
                    "hold": "otherwise; preserve the previous AUTO state", "require_both": False},
        "seed": args.seed, "requested_epochs": args.epochs, "completed_epochs": len(history.history["loss"]),
        "best_epoch_by_validation_loss": int(np.argmin(history.history["val_loss"])) + 1,
        "architecture": [2, 32, 16, 3], "normalization": "folded into first dense layer; runtime takes raw C and %RH",
        "training": {"optimizer": "Adam", "learning_rate": .002, "batch_size": 128,
                     "early_stopping": {"monitor": "val_loss", "patience": 18, "restore_best_weights": True},
                     "deterministic_ops": True, "threads": 1, "cpu_only": True},
        "dataset": {"sha256": hashlib.sha256(csv_content).hexdigest(), "rows": len(xs),
                    "split_method": "session-disjoint" if args.csv else "stratified-disjoint-unique-inputs",
                    "split_sizes": {name: len(indices) for name, indices in parts.items()},
                    "split_sessions": {name: sorted(set(sessions[indices])) for name, indices in parts.items()} if args.csv else None,
                    "input_file_sha256": hashlib.sha256(args.csv.read_bytes()).hexdigest() if args.csv else None},
        "metrics": results, "conversion": conversion,
        "threshold_boundary_diagnostic": {"description": "36 points at/on +/-0.01 of teacher thresholds; deliberately difficult diagnostic, not efficacy validation",
                                          "metrics": classification_metrics(boundary_truth, boundary_probs.argmax(axis=1)),
                                          "softmax_gate": gated_metrics(boundary_truth, boundary_probs),
                                          "conversion": boundary_conversion},
        "environment": {"python": platform.python_version(), "numpy": np.__version__, "tensorflow": tf.__version__,
                        "keras": tf.keras.__version__},
        "limitations": ["Synthetic-policy accuracy measures agreement with a known teacher, not superiority over that teacher.",
                        "Operator labels measure imitation of operator choices, not optimal ventilation or energy savings.",
                        "Softmax values are uncalibrated; boundary mistakes and unseen conditions remain possible.",
                        "Physical fan response, RTOS timing and power safety require independent hardware experiments.",
                        "Exact training bytes may vary across TensorFlow/platform versions; versions, seed and hashes are recorded."],
    }
    # Validate every artifact in memory before replacing the deployed model.
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
    print(json.dumps({"model_version": version, "sha256": digest,
                      "test": results["test"], "conversion": conversion}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, ImportError, OSError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
