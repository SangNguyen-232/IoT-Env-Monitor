# Predictive trend-aware TinyML on ESP32-S3

The DHT20 produces one ambient temperature and relative humidity sample about every five seconds. The network forecasts which hysteresis region the environment will occupy **30 seconds after the newest sample**, assuming the current fan command persists. A rising and a falling trace ending at the same reading can therefore produce different proposals. The forecast runs locally. The deterministic supervisor owns the relay.

## Forecast contract

The training target uses a future T/RH observation with the fixed lab OR profile. The class is **ON** if future T ≥ 30°C or RH ≥ 75%, **OFF** if future T ≤ 28°C and RH ≤ 70%, and **HOLD** elsewhere. HOLD requests the existing relay state. The output scores are ordered OFF, HOLD, ON. The dashboard exposes the proposal, its softmax scores, the static rule class for the current sample and the actual fan decision.

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

## Use the bundled model

The firmware compiles the model bytes and their matching metadata directly from the two headers below. PlatformIO can build the application without Python ML packages. The bundled model is `fan-trend-int8-v2-8abd0b91c744` and its flatbuffer occupies 5,536 bytes. The model ID and full SHA-256 in the manifest identify the embedded weights. The manifest also records the converter configuration, dataset digest, sample counts, reference-interpreter measurements and four sensor trajectories. [Model bytes](../firmware/include/dht_fan_model.h) · [Firmware metadata](../firmware/include/fan_model_metadata.h) · [Model manifest](models/fan_model_manifest.json)

For example, with the fan initially OFF, three simulated windows end at 28.5°C and 71% RH. The exported desktop reference assigns ON (255/256) to the rising trajectory, OFF (246/256) to the falling trajectory and HOLD (255/256) to the steady trajectory. Seven identical readings of 27°C and 74.8% RH yield HOLD with a peak of 141/256, below the gate. Integer kernels can round differently. Read the scores on the device when evaluating its decisions. On the dashboard, agreement compares the model proposal with the threshold class of the **current** sample. Measuring forecast accuracy requires the observation **30 seconds later**. [Board procedure](HIL.md)

## Train and export

Run the following commands in Bash from the repository root on a CPU workstation with Python 3.12 and venv support. Using a temporary directory keeps the export and its dependencies outside the checkout.

```bash
WORK=$(mktemp -d)
python3.12 -m venv "$WORK/venv"
ML_PY="$WORK/venv/bin/python"
"$ML_PY" -m pip install -r ml/requirements.txt
"$ML_PY" -B ml/train_export.py --output-dir "$WORK/candidate"
```

The training command generates the synthetic inputs, fits the network and evaluates the converted model with the desktop TFLite reference interpreter. It imports `int8_export.py` to check tensor types and shapes, the FullyConnected and Softmax operators, and four sensor scenarios. A loss of more than one percentage point of validation accuracy during quantization stops the export. On success, the final JSON summary includes the model ID, byte count, SHA-256, test results and scenario names. [Training entry point](train_export.py) · [INT8 export checks](int8_export.py)

The export writes five files beneath the selected directory.

- `ml/data/dataset.csv` contains the feature rows, independent session identifiers, labels and splits.
- `ml/models/dht_fan_model.tflite` is the portable model.
- `firmware/include/dht_fan_model.h` contains that same flatbuffer as an aligned byte array for the ESP32.
- `firmware/include/fan_model_metadata.h` defines the version, feature contract and reference thresholds.
- `ml/models/fan_model_manifest.json` records the model identity, training provenance and metrics.

The source checkout includes the two firmware headers and the manifest. The CSV and standalone `.tflite` are regenerated outputs. To compare the weights of a default export with the bundled release, run the command below in the same shell. A silent exit with status 0 means the generated and bundled byte-array headers match exactly.

```bash
cmp "$WORK/candidate/firmware/include/dht_fan_model.h" firmware/include/dht_fan_model.h
```

To adopt a candidate, copy both headers and the manifest from that export into their matching repository paths, then rebuild and upload the firmware. Keep the CSV and standalone flatbuffer in the export directory if needed. Omitting `--output-dir` writes all five files into the checkout, including replacements for the bundled headers and manifest.

The default generator creates 24,000 independent synthetic episodes with steady conditions, ramps, smooth peaks and short disturbances. Each episode has one randomly jittered history and a six-step continuation in five-second intervals. Future labels are assigned from the final simulated readings. The simulator draws a variable reduction under an active fan command. This assumption needs validation on the specific enclosure. The synthetic CSV includes inputs in physical units, the OLS slopes, the simulated T/RH outcome and the label. Only the eight explicit feature columns enter the network.

Seed 42 and the episode IDs fix the 70% training, 15% validation and 15% test split. Training selects weights by validation loss. Calibration uses training rows. The held-out test has 3,600 independent episodes. The comparison baselines use the current reading (static policy) and a 30-second linear extrapolation from the two raw OLS rates. Per-class recall, confusion matrices, coverage at the score gate, accuracy on accepted samples and false early alerts are available in the manifest. These measurements describe the simulator. Environmental control benefit needs separate trials with the fan and enclosure.

On the 3,600 synthetic test episodes the desktop INT8 reference predicted the future class correctly in 87.28% of cases. The static baseline reached 71.03% and linear extrapolation reached 82.94%. The score gate accepted 2,769 windows (76.92%) with 95.02% accuracy among those accepted. For the 587 windows already inside the hysteresis band with a sampled OFF command, 145 later reached ON. The score gate proposed 101 early starts, of which 90 reached ON and 11 did not. It missed 55 crossings (89.11% precision, 62.07% recall). Single-decision episodes do not supply dwell history. These counts measure opportunities before dwell enforcement.

The model identifier includes the first 12 hexadecimal digits of the binary's SHA-256. For the bundled release, the manifest records Python 3.12.16, NumPy 2.5.4, TensorFlow CPU 2.21.0 and Keras 3.15.1. Compare the generated binary and dataset hashes against the manifest when reproducing that release. A model trained from recorded sessions has its own dataset, version and metrics.

## Use recorded sessions

On the Admin page, set **History export range** if needed, then choose **Export JSONL** on the device card. The importer also accepts a JSON array, a single history row or an object containing a `rows` array. Keep the shell variables from the training setup above. Pass one or more saved files together when importing independent sessions.

Each in-domain reading needs `device_id`, `boot_id`, `sample_seq` and `sampled_uptime_ms`. The importer deduplicates overlapping pages by device, boot and sequence. Conflicting temperatures, humidities, uptimes or known sampled commands for one identity cause an error. Contiguous readings supply each window's history. Its endpoint needs a ready AI record with matching sequence and uptime and a boolean `ai.fan_on_at_sample`. The top-level `FAN_state` records a later controller decision and cannot supply this input. [History importer](import_history.py)

```bash
"$ML_PY" -B ml/import_history.py /path/to/session-a.jsonl /path/to/session-b.jsonl /path/to/session-c.jsonl \
  --label-source observed-future --output "$WORK/observed.csv"
"$ML_PY" -B ml/train_export.py --csv "$WORK/observed.csv" --label-source observed-future --output-dir "$WORK/observed-candidate"
```

For observed outcomes, each endpoint needs another 30 seconds of uninterrupted valid readings with the same sampled command throughout. If a reading straddles the horizon, the importer linearly interpolates between the neighboring observations. A gap, unknown command or observed switch excludes that target. This checks the command at sample times. Short changes between readings may go undetected. For a controlled trial, hold the relay command fixed and log any intervention. Sparse backend history can be insufficient for training. The import summary reports the resulting window count.

Choose a fresh CSV destination for each import. The importer refuses to overwrite existing labels. Training requires at least 30 labeled windows and at least three distinct sessions, with OFF, HOLD and ON represented in each split. The converter also checks the candidate on the four reference scenarios before writing files.

For operator labeling, omit `--label-source` on import. Enter OFF, HOLD or ON for every row used for training and set its `label_source` column to `operator`. Run the training command above with that CSV and `--label-source operator`. The split keeps each device/boot session together so overlapping windows cannot span training and evaluation. Use enough independent sessions for every split to contain all three classes and keep repeated measurements of a single physical exercise within one experimental partition.
