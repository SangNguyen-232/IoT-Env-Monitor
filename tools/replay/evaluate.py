"""Evaluate the packaged model with the vendored Micro kernels, using only Python stdlib."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import subprocess


def band(t, rh, thresholds):
    t_on, t_off = thresholds["temperature_c"]
    h_on, h_off = thresholds["humidity_pct"]
    if t >= t_on or rh >= h_on:
        return "ON"
    if t <= t_off and rh <= h_off:
        return "OFF"
    return "HOLD"


def evaluate(binary, ml_dir):
    manifest = json.loads((ml_dir / "models/fan_model_manifest.json").read_text())
    dataset = ml_dir / "data/dataset.csv"
    if hashlib.sha256(dataset.read_bytes()).hexdigest() != manifest["dataset"]["sha256"]:
        raise ValueError("Dataset digest differs from the model manifest")
    with dataset.open(newline="") as src:
        rows = [row for row in csv.DictReader(src) if row["split"] == "test"]
    if not rows or len(rows) != manifest["dataset"]["split_sizes"]["test"]:
        raise ValueError("Incomplete test split")
    window = manifest["window"]
    inputs = list(zip(window["features"], window["pre_quantization_divisors"], strict=True))
    features = [" ".join(str(float(row[key]) / scale) for key, scale in inputs) for row in rows]
    run = subprocess.run([binary, "--score-windows"], input="\n".join(features),
                         text=True, stdout=subprocess.PIPE, check=True)
    version, *outputs = run.stdout.splitlines()
    if version != manifest["model_version"]:
        raise ValueError("Rebuild the executable to match the dataset's model version")

    thresholds = manifest["domain"]["reference_thresholds_on_off"]
    labels = manifest["labels_by_index"]
    minutes = window["forecast_horizon_seconds"] / 60
    correct = static_correct = ols_correct = accepted = accepted_correct = 0
    early_tp = early_fp = early_fn = 0
    for row, output in zip(rows, outputs, strict=True):
        scores = list(map(int, output.split()))
        if len(scores) != 3 or abs(sum(scores) - 256) > 2:
            raise ValueError("Invalid quantized scores")
        highest = max(scores)
        prediction = labels[scores.index(highest)]
        truth = row["label"]
        t, rh = float(row["temperature"]), float(row["humidity"])
        static = band(t, rh, thresholds)
        linear = band(t + minutes * float(row["temp_slope_c_min"]),
                      rh + minutes * float(row["humi_slope_pct_min"]), thresholds)
        static_correct += static == truth
        ols_correct += linear == truth
        correct += prediction == truth
        if highest / 256 >= 0.80:
            accepted += 1
            accepted_correct += prediction == truth
        if static == "HOLD" and float(row["fan_on_at_sample"]) == 0:
            proactive = prediction == "ON" and highest / 256 >= 0.80
            early_tp += proactive and truth == "ON"
            early_fp += proactive and truth != "ON"
            early_fn += not proactive and truth == "ON"
    return {
        "model": version, "label_source": manifest["label_source"], "held_out_windows": len(rows),
        "micro_correct": correct, "static_correct": static_correct, "ols_correct": ols_correct,
        "gate_accepted": accepted, "gate_accepted_correct": accepted_correct,
        "early_on_before_dwell": {"true_positive": early_tp, "false_positive": early_fp, "missed": early_fn},
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path, help="Path to the built fan_replay")
    args = parser.parse_args()
    print(json.dumps(evaluate(args.executable.resolve(), Path(__file__).resolve().parents[2] / "ml"), indent=2))
