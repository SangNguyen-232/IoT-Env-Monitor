"""Convert saved admin history to 7-sample inputs and optional +30 s outcome labels."""
from __future__ import annotations

import argparse
import bisect
import csv
import json
from pathlib import Path
import re
import sys
from urllib.parse import quote

import numpy as np

from trend_features import (LABELS, FEATURE_NAMES, HORIZON_SECONDS, WINDOW_SIZE, MAX_STEP_GAP_MS,
                            T_MIN, T_MAX, H_MIN, H_MAX, extract_window_features, band_label)


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


def parse_uint32(value, field: str, minimum: int = 0) -> int:
    if isinstance(value, str) and re.fullmatch(r"0|[1-9][0-9]{0,9}", value):
        value = int(value)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= 4294967295:
        raise ValueError(f"{field} must be an integer in [{minimum},4294967295]")
    return value



def sampled_fan(row):
    # FAN_state is transmitted after actuation. Only this field identifies the
    # command sampled with the DHT input, including when the decision changed it.
    ai = row.get("ai")
    if (isinstance(ai, dict) and ai.get("status") == "ready"
            and str(ai.get("sample_seq")) == str(row.get("sample_seq"))
            and str(ai.get("sampled_uptime_ms")) == str(row.get("sampled_uptime_ms"))
            and isinstance(ai.get("fan_on_at_sample"), bool)):
        return ai["fan_on_at_sample"]
    return None


def continuous_runs(samples):
    run, times = [], []
    for seq, row in samples:
        now = row["_ms"]
        if run:
            prev_seq, previous = run[-1]
            gap = (now - previous["_ms"]) & 0xffffffff
            if seq != (1 if prev_seq == 0xffffffff else prev_seq + 1) or not 0 < gap <= MAX_STEP_GAP_MS:
                yield run, times
                run, times = [], []
        times.append(times[-1] + gap if times else 0)
        run.append((seq, row))
    if run:
        yield run, times


def future_observation(rows, times, i, fan):
    """Interpolate the horizon between consecutive samples under the same observed command."""
    target = times[i] + HORIZON_SECONDS * 1000
    j = bisect.bisect_left(times, target, lo=i + 1)
    if j == len(times) or any(sampled_fan(rows[k][1]) != fan for k in range(i + 1, j + 1)):
        return None
    before, after = rows[j - 1][1], rows[j][1]
    w = (target - times[j - 1]) / (times[j] - times[j - 1])
    return tuple(before[key] + w * (after[key] - before[key]) for key in ("temperature", "humidity"))


def convert(rows: list[dict], label_source: str):
    samples = {}
    skipped_invalid = duplicates = 0
    for i, row in enumerate(rows, 1):
        t, h = row.get("temperature"), row.get("humidity")
        if (type(t) not in (int, float) or type(h) not in (int, float)
                or not T_MIN <= t <= T_MAX or not H_MIN <= h <= H_MAX):
            skipped_invalid += 1
            continue
        try:
            device = scalar_identity(row.get("device_id"), "device_id")
            boot = scalar_identity(row.get("boot_id"), "boot_id")
            seq = parse_uint32(row.get("sample_seq"), "sample_seq", minimum=1)
            ms = parse_uint32(row.get("sampled_uptime_ms"), "sampled_uptime_ms")
        except ValueError as error:
            raise ValueError(f"history row {i}: {error}") from error
        key = device, boot, seq
        old = samples.get(key)
        if old is not None:
            duplicates += 1
            if (t, h, ms) != (old["temperature"], old["humidity"], old["_ms"]):
                raise ValueError(f"Conflicting readings for {key}")
            old_fan, new_fan = sampled_fan(old), sampled_fan(row)
            if old_fan is not None and new_fan is not None and old_fan != new_fan:
                raise ValueError(f"Conflicting sampled fan command for {key}")
            if old_fan is not None:
                continue
        samples[key] = {**row, "_ms": ms}

    grouped = {}
    for (device, boot, seq), row in sorted(samples.items()):
        grouped.setdefault((device, boot), []).append((seq, row))

    output = []
    gaps = missing_command = missing_future = 0
    for (device, boot), sequence in grouped.items():
        session = f"{quote(device, safe='')}:{quote(boot, safe='')}"
        for run_idx, (run, times) in enumerate(continuous_runs(sequence)):
            gaps += int(run_idx > 0)
            for i in range(WINDOW_SIZE - 1, len(run)):
                seq, row = run[i]
                fan = sampled_fan(row)
                if fan is None:
                    missing_command += 1
                    continue
                future = None
                if label_source == "observed-future":
                    future = future_observation(run, times, i, fan)
                    if future is None:
                        missing_future += 1
                        continue
                start = i + 1 - WINDOW_SIZE
                history = [sample for _, sample in run[start:i + 1]]
                ts = np.array(times[start:i + 1]) / 1000
                readings = np.array([[s["temperature"], s["humidity"]] for s in history], dtype=np.float32)
                feats = extract_window_features(readings[:, 0], readings[:, 1], ts, fan)
                centered = ts - ts.mean()
                slopes = centered @ readings / (centered @ centered) * 60
                output.append({
                    **dict(zip(FEATURE_NAMES, map(float, feats))),
                    "temperature": row["temperature"], "humidity": row["humidity"],
                    "temp_slope_c_min": slopes[0], "humi_slope_pct_min": slopes[1],
                    "label": LABELS[int(band_label(*future))] if future else "",
                    "future_temperature_c": future[0] if future else "",
                    "future_humidity_percent": future[1] if future else "",
                    "session_id": session, "sample_seq": seq, "sampled_uptime_ms": row["_ms"],
                    "timestamp_real": row.get("timestamp_real") or "", "label_source": label_source,
                })
    if not output:
        raise ValueError("No complete usable windows. Export contiguous 5 s samples with ai.fan_on_at_sample. "
                         "Observed-future labels also require contiguous follow-up under the same sampled fan command.")
    return output, {
        "input_rows": len(rows), "unique_in_domain_samples": len(samples), "windows": len(output),
        "duplicate_rows": duplicates, "invalid_or_out_of_domain_rows": skipped_invalid,
        "gap_resets": gaps, "windows_missing_sampled_command": missing_command,
        "windows_missing_contiguous_same_command_future": missing_future,
        "sessions": len(grouped), "label_source": label_source,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", type=Path, nargs="+", help="Saved JSON pages or JSONL exports")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--label-source", choices=("unlabeled", "observed-future"), default="unlabeled")
    args = parser.parse_args()
    if args.output.resolve() in {path.resolve() for path in args.inputs}:
        parser.error("output must not overwrite an input file")
    if args.output.exists():
        parser.error("output already exists; choose a new path to preserve manual labels")
    rows = [row for path in args.inputs for row in read_rows(path)]
    converted, report = convert(rows, args.label_source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
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
