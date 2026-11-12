"""Convert saved admin history JSON/JSONL into session-aware labeling CSV.

Default labels are blank: fill OFF/HOLD/ON and set label_source=operator after
an actual labeling review. --label-source synthetic-policy deliberately copies
the fixed teaching rule; it is never evidence of observed fan effectiveness.
No credentials/network are used, and model predictions are never labels.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path
import re
import struct
import sys
from urllib.parse import quote

# Keep this utility usable without NumPy/TensorFlow installed. Values mirror the
# generated fan_model_metadata.h profile and train_export.py.
LABELS = ("OFF", "HOLD", "ON")


def policy_label(temperature: float, humidity: float) -> str:
    if temperature >= 30.0 or humidity >= 75.0:
        return "ON"
    if temperature <= 28.0 and humidity <= 70.0:
        return "OFF"
    return "HOLD"


def read_rows(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8-sig")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = []
        for line, content in enumerate(text.splitlines(), 1):
            if not content.strip():
                continue
            try:
                parsed.append(json.loads(content))
            except json.JSONDecodeError as error:
                raise ValueError(f"{path.name}:{line}: invalid JSONL: {error}") from error
    if isinstance(parsed, dict):
        parsed = parsed.get("rows", [parsed])
    if not isinstance(parsed, list) or not all(isinstance(row, dict) for row in parsed):
        raise ValueError(f"{path.name}: expected history row objects, JSON array, or {{rows:[...]}}")
    return parsed


def scalar_identity(value, field: str) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not str(value).strip():
        raise ValueError(f"missing/invalid {field}; historical rows without sample identity cannot be safely deduplicated")
    result = str(value).strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,64}", result):
        raise ValueError(f"invalid {field}")
    return result


def convert(rows: list[dict], label_source: str) -> tuple[list[dict], dict]:
    samples, skipped_invalid_sensor, duplicate_rows = {}, 0, 0
    for index, row in enumerate(rows, 1):
        # A sensor-null row is a valid status event but not a training sample.
        temperature, humidity = row.get("temperature"), row.get("humidity")
        if (isinstance(temperature, bool) or isinstance(humidity, bool)
                or not isinstance(temperature, (int, float)) or not isinstance(humidity, (int, float))
                or not math.isfinite(temperature) or not math.isfinite(humidity)
                or not 5.0 <= temperature <= 50.0 or not 20.0 <= humidity <= 100.0):
            skipped_invalid_sensor += 1
            continue
        try:
            device = scalar_identity(row.get("device_id"), "device_id")
            boot = scalar_identity(row.get("boot_id"), "boot_id")
            sequence = row.get("sample_seq")
            # PostgreSQL bigint columns are commonly serialized as decimal strings.
            if isinstance(sequence, str) and re.fullmatch(r"[1-9][0-9]{0,9}", sequence):
                sequence = int(sequence)
            if isinstance(sequence, bool) or not isinstance(sequence, int) or not 1 <= sequence <= 4294967295:
                raise ValueError("sample_seq must be an integer in [1,4294967295]")
        except ValueError as error:
            raise ValueError(f"history row {index}: {error}") from error
        key = (device, boot, sequence)
        previous = samples.get(key)
        if previous is not None:
            duplicate_rows += 1
            if (temperature, humidity) != (previous["temperature"], previous["humidity"]):
                raise ValueError(f"Inconsistent readings for duplicated sample {key}")
            old_ai, new_ai = previous.get("ai"), row.get("ai")
            old_ready = (isinstance(old_ai, dict) and old_ai.get("status") == "ready"
                         and str(old_ai.get("sample_seq")) == str(sequence))
            new_ready = (isinstance(new_ai, dict) and new_ai.get("status") == "ready"
                         and str(new_ai.get("sample_seq")) == str(sequence))
            if old_ready and not new_ready:
                continue
        samples[key] = row
    output = []
    for (device, boot, sequence), row in sorted(samples.items(), key=lambda item: item[0]):
        # Match training/deployed float32 before applying threshold labels.
        temperature, humidity = (struct.unpack("<f", struct.pack("<f", row[name]))[0]
                                 for name in ("temperature", "humidity"))
        output.append({
            "temperature": temperature, "humidity": humidity,
            "label": policy_label(temperature, humidity) if label_source == "synthetic-policy" else "",
            "session_id": f"{quote(device, safe='')}:{quote(boot, safe='')}", "label_source": label_source,
            "device_id": device, "boot_id": boot,
            "sample_seq": sequence, "sampled_uptime_ms": row.get("sampled_uptime_ms", ""),
            "timestamp_real": row.get("timestamp_real") or "", "fan_state": row.get("FAN_state", ""),
            "mode_state": row.get("MODE_state", ""),
            "fan_decision_sample_seq": row.get("fan_decision_sample_seq", ""),
            "fan_decided_uptime_ms": row.get("fan_decided_uptime_ms", ""),
        })
    if not output:
        raise ValueError("No valid in-domain identified DHT samples were found")
    session_sequences = {}
    for row in output:
        session_sequences.setdefault(row["session_id"], []).append(row["sample_seq"])
    coverage = []
    for session, sequences in session_sequences.items():
        first, last = min(sequences), max(sequences)
        coverage.append({"session_id": session, "first_sequence": first, "last_sequence": last,
                         "retained_samples": len(sequences),
                         "missing_sequence_ids_within_observed_span": last - first + 1 - len(sequences)})
    return output, {"input_rows": len(rows), "output_samples": len(output), "duplicate_rows": duplicate_rows,
                    "skipped_invalid_or_out_of_domain_sensor_rows": skipped_invalid_sensor,
                    "sessions": len(session_sequences), "label_source": label_source,
                    "sequence_coverage": coverage,
                    "missing_sequence_ids_within_observed_spans": sum(item["missing_sequence_ids_within_observed_span"] for item in coverage),
                    "coverage_limit": "Counts gaps only between first/last retained IDs; filtered readings, export limits and dropped events can all produce gaps. Capture completeness is not established; no interpolation is performed."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", type=Path, nargs="+", help="Saved JSON pages or JSONL exports")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--label-source", choices=("unlabeled", "synthetic-policy"), default="unlabeled")
    args = parser.parse_args()
    if args.output.resolve() in {path.resolve() for path in args.inputs}:
        parser.error("output must not overwrite an input file")
    if args.output.exists():
        parser.error("output already exists; choose a new path to preserve manual labels")
    rows = [row for path in args.inputs for row in read_rows(path)]
    converted, report = convert(rows, args.label_source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation prevents overwriting a concurrently prepared labeling file.
    with args.output.open("x", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(converted[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(converted)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
