# Bench guide for the ESP32-S3 fan controller

Use the device dashboard and a Serial monitor to observe what the model predicts, which command the controller applies and how the fan responds. The six checks below exercise SHADOW, AI, the saved threshold rule and recovery from sensor loss. You can run them on the local network without a backend. A connected backend is useful for collecting a session afterwards.

## Prepare the device

1. Build and upload the firmware and its matching LittleFS dashboard. The DHT20 and LCD share SDA on GPIO11 and SCL on GPIO12. GPIO10 drives the fan through an active-high relay or driver. Use a low-voltage DC fan on its rated supply and keep moisture away from the electronics. The soil probe on GPIO2 is independent of the fan. [Build, wiring and provisioning guide](../GUIDE.md)
2. From the repository root, identify the USB serial port and open the monitor. Replace the example port with the one shown for the board. Close the monitor before a subsequent firmware upload.

   ```bash
   pio device list
   pio device monitor --port /dev/ttyACM0 --baud 115200
   ```

3. On the LAN, open the station IP printed by the board. In provisioning mode, join the device access point and open `http://192.168.4.1/`. Open **Settings → Fan** (`/#settings/fan`) to configure the relay. Use **Settings → TinyML** (`/#settings/tinyml`) on the same host to inspect a forecast. The station interface uses the device HTTP credentials configured for this build.
4. Record the current mode and thresholds before changing them. Check the model ID against the manifest. After successful model initialization, Serial reports `[AI] model=...` and the TinyML status reports `ai.model_version`. The bundled version is `fan-trend-int8-v2-8abd0b91c744`. A startup message about failed INT8 initialization indicates that the deterministic fallback is active. Ordinary reboot starts the controller in AUTO. Uploading a LittleFS image replaces saved device settings. [Bundled model manifest](models/fan_model_manifest.json)
5. In browser developer tools, enable **Preserve log** in the Network panel. **Save fan settings** sends `POST /api/fan-config` and returns HTTP 200 on success. Choosing a mode and clicking **Apply** sends `GET /set-mode?mode=...` and returns HTTP 202 when accepted. Wait until the displayed mode changes before collecting a sample.

You can inspect both read-only snapshots from the console of the device page.

```javascript
for (const path of ["/api/fan-config", "/api/ai-status"]) {
  const response = await fetch(path, { cache: "no-store" });
  console.log(path, response.status, await response.json());
}
```

## Read the measurements

The model needs seven consecutive valid readings, normally five seconds apart, within 5–50°C and 20–100% RH. Expect about 30 seconds from the first good reading to a full window. Missing sample sequence numbers, repeated timestamps, gaps over eight seconds, invalid measurements and out-of-domain measurements restart the window. During warmup, AI uses the configured threshold rule.

- The `[AI]` line reports the sample sequence, acquisition uptime, window size and GPIO command at sampling. A ready result adds the temperature and humidity trends, static reference class, forecast, three scores in OFF/HOLD/ON order and inference time.
- The `[FAN]` line reports decision uptime, mode, applied GPIO command and reason. A new line can record a reason change while the GPIO stays at the same level. Use actual OFF-to-ON and ON-to-OFF transitions when measuring dwell time.
- In `/api/ai-status`, check that `sample_seq`, `ai.sample_seq` and `fan_decision_sample_seq` match within the same `boot_id`. Also match `sampled_uptime_ms` with `ai.sampled_uptime_ms`. A new acquisition may reach the API before inference or control finishes. The next matching snapshot or Serial entries for that sample supply the decision.
- Record the relay indicator, fan movement or airflow separately. A GPIO log records the electrical command issued by firmware. A fan can coast after the relay releases.

## Six bench checks

### 1. First boot without saved thresholds

Use a newly provisioned board for this check. If the board already has settings that must be preserved, record this check as unobserved. With `configured=false`, AUTO should hold GPIO10 OFF with `config_required`. Request SHADOW and AI in turn. Each request should return HTTP 409 with `Save a valid AUTO fallback configuration first`. Verify that the applied mode remains AUTO. A 401 means the device needs authentication. A 503 indicates temporarily unavailable fan control.

### 2. SHADOW observes while the saved rule controls the relay

Save temperature ON/OFF of 35/32°C and humidity ON/OFF of 85/80%, using OR (`activation_logic="any"`). Verify the saved values, enter SHADOW, and start with the fan OFF. Wait for a ready 7/7 window and ten seconds after the mode change. Gradually increase humidity near the sensor while keeping temperature below 35°C and humidity below 85%. For example, hold RH around 77% briefly. A matching sample with `predicted_class=ON`, `fan_state=OFF` and `fan_reason=rule_off` demonstrates that the model can request ventilation while the saved rule keeps the relay OFF. Observe the physical fan as well.

### 3. AI uses the fallback when its reference profile differs

Leave the custom 35/32°C and 85/80% OR thresholds in place and select AI. Confirm HTTP 202 and the applied AI mode. After the transition, expect `ai_fallback_profile_mismatch` with valid readings. The saved thresholds control the relay even when the model has a confident forecast. An initially OFF fan should stay OFF below both custom upper thresholds.

### 4. Early start, falling trend and relay dwell

Save the model's reference profile of 30/28°C and 75/70% RH with OR. Begin each run with the fan OFF, a ready window and at least ten seconds since the last mode change or OFF transition.

1. In SHADOW, gradually raise humidity toward 71–74% at a temperature below 30°C. Look for a sample with current class HOLD, predicted class ON and ON score at least 0.80. Below both upper thresholds the fan stays OFF. If the same trace later crosses either upper threshold, record the elapsed time from the first qualifying proposal to the threshold-driven ON edge.
2. In AI, repeat the gradual rise from similar starting conditions. A matching HOLD sample with a qualifying ON forecast should produce `ai_proactive_on` and an ON command. Observe the relay and fan. The physical response can alter the next temperature and humidity readings.
3. For the falling comparison, start the fan OFF in AI and produce a gradual decrease ending near the same reading in the HOLD band. Check the last seven readings, the actual proposal and the GPIO. An OFF or HOLD proposal can leave the fan OFF. Compare matched endpoints and record the different trends.
4. After a fresh ON transition, allow both readings to fall to or below their OFF thresholds. If they cross before ten seconds and remain low, expect `min_on_time` followed by an OFF edge at least 10,000 ms after the ON edge, provided samples remain valid and the configuration stays the same. If the environment cools too slowly, record the dwell case as unobserved.

### 5. Low-confidence forecast falls back to the saved rule

Stay in AI with the reference profile and the fan initially OFF. With a full window, try steady conditions near 27°C and 74.8% RH for seven samples. In the bundled model's desktop reference this trajectory has a peak score below 0.80. Use the actual device scores from `ai.probabilities`. For a ready sample with all scores below 0.80 and no pending dwell transition, expect `ai_fallback_low_score`. At the example readings the saved rule holds the fan OFF. If the bench never produces a below-gate sample, record that condition explicitly.

### 6. Invalid sensor input shuts the fan down and restarts warmup

On a low-voltage bench with a removable DHT20 signal connection, leave the LCD branch connected. With AI active, record a fresh ON edge and disconnect only the sensor's SDA or SCL signal through the next acquisition. At the first invalid reading, expect null temperature, humidity and proposal in the status JSON, `ai.status=sensor_invalid`, zero window samples and a fan OFF decision with `sensor_invalid`. Confirm relay release. The invalid reading bypasses the normal ten-second ON dwell. If acquisition stops altogether, an age greater than 15 seconds triggers the stale-reading safety path.

Reconnect the DHT20 and observe warmup increasing to 7/7 after consecutive valid readings. To measure reaction time, subtract the invalid sample's `sampled_ms` from the matching OFF edge's `decided_ms` within the same boot. Measuring the delay from disconnect to relay release requires an independent time reference, such as video. Restore the previous settings and confirm them through the FAN page.

## Compare a forecast with an observed outcome

For each run, record the model version, device and boot IDs, mode, thresholds, sample sequence, acquisition uptime, forecast scores, applied command, decision reason and physical observation. Mark a case as observed only when both the input condition and its outcome were captured.

On the backend Admin page, set **History export range** in the browser’s local time and click **Export JSONL** on the device card. The start time is inclusive and the end is exclusive. Use the ML import workflow to turn contiguous history into labeled windows. At five-second intervals, one complete outcome needs seven history samples and six further intervals under the same sampled fan command. Compare the prediction at the original sample with the threshold class at the 30-second horizon. Changes between sample times can go unseen, so record interventions during the session. [History import and label rules](README.md#use-recorded-sessions)

If the importer reports zero usable windows and exits, check the original sample sequences, time gaps, matching AI records and follow-up readings. When it produces a CSV, its summary counts the gaps and windows excluded for missing commands or outcomes. The dashboard's agreement percentage compares the forecast to the current reference class. Evaluating ventilation effects also requires independent physical measurements of the enclosure and fan.
