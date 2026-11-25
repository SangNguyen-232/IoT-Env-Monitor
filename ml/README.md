# Predictive trend-aware TinyML on ESP32-S3

The DHT20 produces one ambient temperature and relative humidity sample about every five seconds. The network forecasts which hysteresis region the environment will occupy **30 seconds after the newest sample**, assuming the current fan command persists. A rising and a falling trace ending at the same reading can therefore produce different proposals. The forecast runs locally. The deterministic supervisor owns the relay.

## Forecast contract

The training target uses a future T/RH observation with the fixed lab OR profile. The class is **ON** if future T ≥ 30°C or RH ≥ 75%, **OFF** if future T ≤ 28°C and RH ≤ 70%, and **HOLD** elsewhere. HOLD requests the existing relay state. The head predicts three classes. The dashboard exposes the proposal, its softmax scores, the static rule class for the current sample and the actual fan decision.

The input window requires seven consecutive valid in-domain readings, spanning nominally 30 seconds from first to last. Sequence gaps, a zero time step, an interval over eight seconds, an invalid reading or an out-of-domain reading restart warmup. The input range gate accepts 5–50°C and 20–100% RH. Synthetic episodes emphasize readings near the control thresholds. Generalization across the full input range needs field data. Python and firmware use actual sample timestamps to compute the eight features in the following order.

1. Current temperature relative to the OFF threshold, in temperature-band units of 2°C.
2. Current humidity relative to the OFF threshold, in humidity-band units of 5 percentage points.
3. Temperature trend by ordinary least squares over all seven samples, in bands per minute.
4. Humidity trend over the same window, in bands per minute.
5. Temperature rate between the last two samples, in bands per minute.
6. Humidity rate between the last two samples, in bands per minute.
7. Variation around the two fitted lines. Divide each residual by its channel's band width, then compute the square root of the mean of the two squared residuals **summed** at each time step.
8. The fan GPIO command sampled before actuation for this DHT reading (OFF = 0, ON = 1). Physical fan motion requires a separate observation.

Channels 1–7 are clipped to ±4 and divided by 4. The fan bit passes through directly. The network has two ReLU hidden layers of widths 64 and 32, and a three-class softmax. The converter calibrates activations on a seeded subset of training windows. Feature extraction uses floating-point arithmetic, followed by quantization using the exported input scale and zero point. All graph tensors are INT8 or INT32. Weights use a single scale per tensor for compatibility with the vendored fully-connected kernel. The firmware dequantizes the three INT8 outputs for display and gating. Its gate accepts a peak score of at least 0.80. The scores have 1/256 resolution and their sum can differ slightly from one.

## Replay the shipped artifact

From the repository root, use Python 3.12 and the pinned CPU environment. The replay runs the desktop TFLite reference interpreter and checks all three proposals plus a below-gate stationary trace. Different integer-kernel rounding paths can move a score or a near-boundary decision. Use the vendored Micro replay for the firmware-kernel result and observe the live score on the board.

```bash
python3.12 -m venv /tmp/fan-ml
/tmp/fan-ml/bin/python -m pip install -r ml/requirements.txt
/tmp/fan-ml/bin/python ml/replay.py
```

The desktop reference reports ON 255/256 on the rising trace, OFF 246/256 on the falling trace and HOLD 255/256 on the steady trace. At seven identical 27°C / 74.8% RH readings it proposes HOLD with a peak of 141/256, below the gate.

All three comparison windows end at 28.5°C / 71% RH with the fan initially OFF and every sample below the ON thresholds. Inspect the rising, falling and steady outputs and the exact samples in the JSON. SHADOW lets you watch the same forecasts while the saved hysteresis rule controls the GPIO. In AI mode the profile, sample identity, status, score and dwell checks govern actuation. The observed agreement percentage on the device compares the model with the **current** fixed static rule. A correct early forecast can reduce that percentage.

For the exact vendored Micro inference kernels, build the firmware replay on a host with CMake and a C++20 compiler. The evaluator needs Python 3.10+ and uses the standard library. The model training, desktop replay and history import commands in this guide use the Python 3.12 ML environment.

```bash
cmake -S tools/replay -B /tmp/fan-replay -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/fan-replay --parallel 2
/tmp/fan-replay/fan_replay
python3 tools/replay/evaluate.py /tmp/fan-replay/fan_replay
```

On the same test CSV the vendored Micro kernels scored **3,151/3,600 (87.53%)** versus **3,142/3,600 (87.28%)** for the desktop TFLite reference. The static and OLS baselines scored 2,557 and 2,986 respectively. Micro accepted 2,771 forecasts at the 0.80 gate, with 2,632 correct. Among the eligible early-start opportunities it found 91 true positives, 12 false positives and 54 missed crossings before dwell enforcement. For the 27°C / 74.8% RH low-score fixture, Micro returned HOLD 134/256. Both runtimes trigger the low-score fallback on this fixture. The HIL guide gives expected settings, Serial evidence and physical steps. [Bàn thử và sáu kịch bản HIL](HIL.vi.md)

## Train and evaluate

```bash
/tmp/fan-ml/bin/python ml/train_export.py --output-dir /tmp/fan-model-candidate
```

The default generator creates 24,000 independent synthetic episodes with steady conditions, ramps, smooth peaks and short disturbances. Each episode has one randomly jittered history and a six-step continuation in five-second intervals. Future labels are assigned from the final simulated readings. The simulator draws a variable reduction under an active fan command. This assumption needs validation on the specific enclosure. The synthetic CSV includes inputs in physical units, the OLS slopes, the simulated T/RH outcome and the label. Only the eight explicit feature columns enter the network.

Seed 42 and the episode IDs fix the 70% training, 15% validation and 15% test split. Training selects weights by validation loss. Calibration uses training rows. The held-out test has 3,600 independent episodes. The comparison baselines use the current reading (static policy) and a 30-second linear extrapolation from the two raw OLS rates. Per-class recall, confusion matrices, coverage at the score gate, accuracy on accepted samples and false early alerts are available in the manifest. These measurements describe the simulator. Environmental control benefit needs separate trials with the fan and enclosure.

On the 3,600 synthetic test episodes the desktop INT8 reference predicted the future class correctly in 87.28% of cases. The static baseline reached 71.03% and linear extrapolation reached 82.94%. The score gate accepted 2,769 windows (76.92%) with 95.02% accuracy among those accepted. For the 587 windows already inside the hysteresis band with a sampled OFF command, 145 later reached ON. The score gate proposed 101 early starts, of which 90 reached ON and 11 did not. It missed 55 crossings (89.11% precision, 62.07% recall). Single-decision episodes do not supply dwell history. These counts measure opportunities before dwell enforcement.

Two exports in the pinned CPU environment produced byte-identical model binaries, datasets and firmware headers. Each export writes a feature CSV, the TFLite flatbuffer, the evaluation manifest, the aligned firmware byte array and the firmware metadata header under the chosen output root. Use the headers and binary from the same export. The model identifier embeds the first 12 hexadecimal digits of the binary's SHA-256. The manifest also records the full binary and dataset hashes, software versions and split sizes. [Shipped manifest](models/fan_model_manifest.json)

## Use recorded sessions

Export admin history as JSON, JSONL or a JSON object containing a `rows` array. The importer accepts overlapping pages and deduplicates readings by device, boot and sample sequence. It reconstructs windows only within contiguous sequences, using the saved sample uptime. It obtains the predecision fan command from `ai.fan_on_at_sample` on the matching inference record. Older rows without the field can supply past T/RH history but cannot serve as a labeled decision endpoint.

```bash
/tmp/fan-ml/bin/python ml/import_history.py session*.json --label-source observed-future --output /tmp/fan-observed.csv
/tmp/fan-ml/bin/python ml/train_export.py --csv /tmp/fan-observed.csv --label-source observed-future --output-dir /tmp/fan-observed-candidate
```

For observed outcomes, each endpoint needs another 30 seconds of uninterrupted valid readings with the same sampled command throughout. If a reading straddles the horizon, the importer linearly interpolates between the neighboring observations. A gap, unknown command or observed switch excludes that target. This checks the command at sample times. Short changes between readings may go undetected. For a controlled trial, hold the relay command fixed and log any intervention. Sparse backend history can be insufficient for training. The import summary reports the resulting window count.

Omit `--label-source` on import to prepare unlabeled inputs for operator review. Enter OFF/HOLD/ON and mark each reviewed row `label_source=operator`. On training, supply the matching label source. The split keeps each device/boot session together so overlapping windows cannot span training and evaluation. Use enough independent sessions for every split to contain all three classes and keep repeated measurements of a single physical exercise within one experimental partition.
