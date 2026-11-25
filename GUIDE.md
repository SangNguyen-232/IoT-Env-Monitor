# Getting started with IoT-Env-Monitor

Choose a starting point based on the equipment you have.

- **Laptop only.** Clone the repository, then follow [the local backend walkthrough](#3-start-the-local-backend-without-a-board). It takes you from an empty database to a device card with one demonstration reading.
- **Laptop and Yolo Uno.** Start the local backend if you want to collect history. [Build the two images](#4-prepare-the-board-configuration-and-compile), [upload and provision the board](#5-wire-upload-and-provision-the-esp32), then [check the dashboards and relay](#6-check-the-dashboards-and-fan-control). The board can monitor sensors and control the fan locally without a backend.
- **Server or model development.** Use [the Cloudflare route](#7-run-the-containerized-backend-and-optional-cloudflare-gateway) to reach a containerized backend, or [the Python workflows](#8-optional-workstation-tools) to train a candidate model or read saved board settings. For a source release, see [Preparing a public commit](#10-preparing-a-public-commit).

## 1. Clone the project

In a Bash terminal, change to the directory where you keep your projects, then run the following. The examples use Linux paths. In a Windows PowerShell terminal, supply the board's COM port directly to PlatformIO (for example, `--upload-port COM5`). The shell variables and here-documents below use Bash syntax.

```bash
git clone --branch project_linux https://github.com/SangNguyen-232/IoT-Env-Monitor.git
cd IoT-Env-Monitor
git branch --show-current
```

The last command should print `project_linux`. Run each command block from this repository root unless it specifies another directory. Keep the source for the backend, firmware and device dashboard on the same revision so that they agree on telemetry fields and control modes.

## 2. Choose the tools for your setup

- **Local backend and database.** Install Docker Engine with the Compose plugin, or Docker Desktop, on the host that will receive readings. Start Docker and verify `docker info` and `docker compose version`. PostgreSQL runs in a container. The local route below runs the JavaScript/Express backend directly on the host. [Docker installation options](https://docs.docker.com/compose/install/)
- **Host JavaScript development.** Both services specify Node `>=26.12.0 <27` and npm `>=12.2.0 <13`. With nvm installed, run `nvm install` and `nvm use` at the repository root to select the version in `.nvmrc`. Check `node --version` and `npm --version`. If npm is outside the declared range, run `npm install --global npm@12.2.0` in that nvm environment. The containerized backend supplies its own Node and npm. Dependencies for the backend and Worker each have their own lockfile and are installed inside the respective service directory.
- **Firmware.** Install PlatformIO Core, or open the project with the PlatformIO IDE extension for VS Code and use its terminal. Verify `pio --version`. PlatformIO installs the pinned Espressif platform and Arduino libraries on the first build. The C/C++ firmware uses FreeRTOS, the bundled TensorFlow Lite Micro sources and LittleFS. The device dashboard is HTML, CSS and JavaScript. [PlatformIO Core installation](https://docs.platformio.org/en/latest/core/installation/methods/installer-script.html)
- **Optional training and flash utilities.** Use the Python 3.12 environment in section 8 for the pinned CPU training packages. Firmware builds already include trained weights. Cloudflare account credentials are only needed for the remote gateway workflow.

## 3. Start the local backend without a board

Choose a fresh lab database for a first run. The Compose project uses fixed container names and binds PostgreSQL to `127.0.0.1:5433`. If an installation is already serving data, inspect `docker compose ps` first. For an existing volume, review the migration and backup steps before starting a newer backend. [Database migrations](database/MIGRATIONS.md)

Create your private settings once. The conditional copy preserves an existing configuration.

```bash
test -f .env || (umask 077 && cp .env.example .env)
```

Open `.env` in your editor and set credentials for this installation. The public template leaves `SENSOR_API_KEY` empty. Use separate random values for the database password, session secret and device key. For example, `openssl rand -hex 32` generates one secret per invocation.

- Set `DB_HOST=127.0.0.1`, `DB_PORT=5433`, `DB_NAME`, `DB_USER` and `DB_PASS`. Compose passes matching credentials to PostgreSQL on its first initialization. Existing volumes keep their existing accounts and passwords.
- Set `SESSION_SECRET` for signed sessions and `SENSOR_API_KEY` for device telemetry and LAN tickets. Save the same newly generated device key in the firmware configuration in section 4. For a system already in use, follow the credential rotation notes in section 10.
- Set `ADMIN_USERNAME` and `ADMIN_PASSWORD`. The backend creates this account when the user table is empty. Editing these variables later does not reset an existing account.
- Set `SENSOR_RETENTION_DAYS` to the number of days to retain telemetry. The default is 30. The backend runs cleanup at startup and every six hours. Set it to 0 before collecting a session that you want to retain indefinitely.
- For this local route leave a nonempty value such as `unused-local` in `CLOUDFLARE_TUNNEL_TOKEN`. Compose validates the setting while reading the file, even when only PostgreSQL is selected. This route starts only PostgreSQL in Docker.

Start the database, then the backend. Keep this terminal open while using the application.

```bash
docker compose config --quiet
docker compose up -d --wait postgres
(cd services/backend && npm ci && node --env-file=../../.env src/index.js)
```

Look for `API running on port 3000`. In a second terminal, run the following check and visit `http://localhost:3000/login`. Sign in with the admin credentials you supplied. A fresh database shows an empty device list until a device posts a reading.

```bash
curl -fsS http://127.0.0.1:3000/healthz
```

Expected response is `{"ok":true}`. This checks that Express can query PostgreSQL. For a device on the LAN, use the host computer's LAN address, such as `http://192.168.1.20:3000`. Allow TCP 3000 from that LAN and check from a second device. If using a VM or WSL, check that the address and port are reachable from the physical Wi-Fi network. If port 3000 is busy, prefix the host Node command with `PORT=3001`. Use that port for the browser, device URL, health check and demo sender in the second terminal. Keep the containerized backend on port 3000, which its health check and tunnel configuration use.

**Optional ingestion check on a disposable lab database.** In the second terminal, change to the repository root and send one labeled demonstration reading to the locally running backend. The command uses the device key from your private environment and creates a row for `guide-demo`. If you supplied a custom port in the first terminal, also run `export PORT=3001` (using your port) in this terminal before sending.

```bash
node --env-file=.env --input-type=module <<'JS'
const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/sensor`, {
  method: "POST",
  headers: {"Content-Type": "application/json", "X-Device-Key": process.env.SENSOR_API_KEY},
  body: JSON.stringify({
    device_id: "guide-demo", timestamp_up: new Date().toISOString(),
    temperature: 26.5, humidity: 64, FAN_state: "OFF", MODE_state: "AUTO"
  })
});
console.log(response.status, await response.text());
if (!response.ok) process.exitCode = 1;
JS
```

Expect `200 OK` and a `guide-demo` card on the admin page after its next refresh. This exercises HTTP ingestion, persistence and listing with a known input.

To stop a local session, press Ctrl+C in the backend terminal and run `docker compose stop postgres` in the project root. The named volume retains the data.

## 4. Prepare the board configuration and compile

The selected PlatformIO environment is `yolo_uno`. The board definition targets a Yolo Uno ESP32-S3 with 8 MB flash and the `default_8MB.csv` partition layout. From the root, create the private header once.

```bash
test -f firmware/include/secrets.h || (umask 077 && cp firmware/include/secrets.h.example firmware/include/secrets.h)
```

The example header supplies values for a compilation check. Before uploading an application image, edit the private copy with the values for this board. The application binary embeds those credentials.

- Set `SSID_AP` and `PASS_AP` for the setup access point. Use a WPA2 passphrase of 8–63 ASCII characters.
- Set `DEVICE_HTTP_USER` and `DEVICE_HTTP_PASS` for direct LAN and OTA login. These belong to the board. The central admin account belongs to the backend.
- Set `SENSOR_API_KEY` to the exact key from `.env`. Set `SENSOR_API_URL` to the backend origin reachable **from the board**, such as `http://192.168.1.20:3000`. The firmware appends `/sensor`. A saved URL in the device's Wi-Fi settings takes precedence at startup.
- Use a trusted lab network. Device HTTP Basic credentials, the LAN dashboard and HTTP telemetry cross the LAN in clear text. The current firmware HTTPS client uses `setInsecure()`, so it skips server certificate verification.

Build the application and dashboard filesystem separately.

```bash
pio run -e yolo_uno
pio run -e yolo_uno -t buildfs
```

Both commands should finish with `SUCCESS`. Look for `.pio/build/yolo_uno/firmware.bin` and `.pio/build/yolo_uno/littlefs.bin`. The filesystem image contains `dashboard.html`, `dashboard.css` and `dashboard.js`. These commands leave the board untouched.

## 5. Wire, upload and provision the ESP32

With power disconnected, connect the DHT20 and 16×2 LCD to the shared I²C bus, SDA on GPIO11 and SCL on GPIO12. The firmware uses LCD address `0x27`. The optional soil probe connects to GPIO2. Keep sensor signals within the board's input ratings. The status LED uses GPIO48 and the onboard NeoPixel uses GPIO45. GPIO10 is an active-high relay control signal. Power the fan through a suitably rated driver and supply. The dashboard reports the GPIO command. To verify fan motion you need a separate observation.

Connect the board with a data-capable USB cable. Run `pio device list` and identify the port by unplugging and reconnecting the board if necessary. For a VM, pass the USB device through to the guest. On Linux, inspect the device group with `ls -l /dev/ttyACM0`. If the group is `dialout`, a user without access can run `sudo usermod -aG dialout "$USER"` and sign out and back in. Close any program holding the serial port before uploading.

**Before uploading LittleFS to a board already in use**, record the Wi-Fi, backend URL and fan settings you will need again. `uploadfs` replaces the filesystem, including the saved settings. Use it on first installation and when updating the dashboard assets. A normal application upload with the same partition layout preserves those files. The application enables automatic formatting if LittleFS fails to mount at startup.

```bash
board_port=/dev/ttyACM0   # Substitute the port reported by pio device list.
pio run -e yolo_uno -t upload --upload-port "$board_port"
pio run -e yolo_uno -t uploadfs --upload-port "$board_port"
pio device monitor --port "$board_port" --baud 115200
```

On startup, the LCD shows the following greeting for five seconds, then switches to sensor readings. The bars mark the edges of the 16 display columns.

```text
|   IOT    ENV   |
|  MONITOR  SYS  |
```

1. On a board with an empty Wi-Fi configuration, look for `AP Mode IP address: 192.168.4.1` in the serial monitor. Join the setup network using `SSID_AP` and `PASS_AP` and open `http://192.168.4.1/`.
2. Under **Settings → WiFi**, enter the router's 2.4 GHz SSID and password, confirm the backend URL, then choose **Save & connect**. Saving a new SSID restarts the board. Rejoin the router's network on your computer.
3. Find `STA Mode IP address:` in the serial monitor. Open that address in the browser using the board's HTTP credentials. When saved Wi-Fi is unavailable, the device provides the setup access point and periodically retries the saved network.
4. Allow DNS and network time synchronization. The board uses `pool.ntp.org` and `time.nist.gov` and starts posting timestamped telemetry once its clock is valid. Visit the central admin page again. The device card should now show its MAC, LAN IP and readings.
5. For later browser-based firmware updates, the board serves ElegantOTA at `http://<board-ip>/update`. Use the device credentials and select the image type matching your file. A filesystem OTA update also replaces device settings. Holding the BOOT button on GPIO0 for more than two seconds while the application is running clears saved network, backend and fan settings.

## 6. Check the dashboards and fan control

The central admin page at `/admin/` lists devices and exports per-device history as JSONL. The device dashboard at `http://<board-ip>/` shows live readings and separate Wi-Fi, FAN and TinyML settings. An operator opening the board from the central dashboard needs network access to its LAN IP. Device tickets are bound to the board identity, LAN IP and a five-minute expiry. An administrator can use **Create user** and **Assign access** to grant a user access to a specific device and LAN IP. A user who opens an authorized board enters its device password or requests administrator approval when no password has been set. Direct board login uses the separate HTTP credentials from the firmware header.

1. Check the local dashboard and LCD for temperature and humidity. Samples arrive about every five seconds. Soil readings are independent. The endpoints of the soil ADC range (0 and 4095) produce an unavailable reading.
2. In **Settings → Fan**, enter ON and OFF thresholds for both temperature (−40 to 80 °C) and relative humidity (0 to 100%), choose OR or AND, then select **Save fan settings**. Select a mode and choose **Apply**. Each OFF value must be below its ON value. Until this is done, AUTO keeps the relay off and requests for SHADOW or AI receive HTTP 409.
3. Use **AUTO** to check the saved hysteresis. OR turns on when either upper threshold is reached and turns off when both lower thresholds are reached. AND turns on when both upper thresholds are reached and turns off when either lower threshold is reached. Normal automatic transitions observe a ten-second dwell. Invalid or stale DHT readings force automatic shutoff.
4. Use **SHADOW** to compare the model proposal with the rule-driven relay command in **Settings → TinyML**. For the shipped model, set temperature ON/OFF to 30/28 °C, humidity ON/OFF to 75/70% and logic to OR before trying **AI**. Seven consecutive in-domain readings are needed for a forecast. With a matching profile and sufficient score (at least 0.80), AI can start the fan early inside the hysteresis band. Other profiles use your saved rules as fallback.
5. **MANUAL** accepts direct ON/OFF requests and limits a continuous run to five minutes. A reboot selects AUTO and reloads the saved thresholds. For physical trials, record the sample sequence, applied fan reason and observed relay or fan response. [Hardware bench procedures](ml/HIL.md)

To check ingestion on an installation you control, inspect the latest rows with this read-only query. Compare the device identifier and sequence with the serial output and the exported history.

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT received_at, device_id, sample_seq, temperature, humidity,
       "FAN_state", "MODE_state", fan_reason
FROM sensor_logs ORDER BY id DESC LIMIT 5;
SQL
```

## 7. Run the containerized backend and optional Cloudflare gateway

Use this route when the backend is to run in Docker behind a tunnel. Stop the directly running Node process first if switching from section 3. The Compose backend listens on port 3000 **inside** the Docker network. Only PostgreSQL publishes a host port, on loopback. The service dependencies, images and volumes are defined in [docker-compose.yml](docker-compose.yml).

1. Create a Cloudflare Tunnel for this installation. Put its connector token in `CLOUDFLARE_TUNNEL_TOKEN` in `.env`. For the Worker route, create an HTTP VPC Service associated with that tunnel, hostname `backend`, HTTP port `3000`. The connector can resolve that name on the shared Compose network. Use your own service ID in `services/gateway/wrangler.jsonc`, keeping the binding name `IOT_BACKEND`. Set a Worker name appropriate to your account. [Cloudflare VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)
2. Start the stack and verify the origin from inside the backend container. PostgreSQL and the backend have health checks. Inspect the connector log for tunnel registration.

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=30 cloudflared
docker compose exec -T backend node -e 'fetch("http://127.0.0.1:3000/healthz").then(async r => { console.log(r.status, await r.text()); process.exitCode = r.ok ? 0 : 1 })'
```

3. On a machine with the project Node/npm versions, install the Worker's dependencies and verify the bundle locally. When ready to publish on your own account, authenticate and deploy from the gateway directory.

```bash
(cd services/gateway && npm ci && npx wrangler deploy --dry-run)
(cd services/gateway && npx wrangler login && npm run deploy)
```

4. Open `/healthz` and `/login` at the deployed URL. Configure the device to use that origin for telemetry. `npm run dev` in the gateway directory starts Wrangler development mode with a remote VPC binding and requires access to that Cloudflare resource. A successful dry run verifies packaging. The public health request also exercises routing and the database.
5. `docker compose stop` stops the services and retains the volume. For an older database, follow the backup and migration instructions. First initialization loads the base schema, then migrations 001, 003, 004 and 005. Migration 002 is for legacy timestamp conversion. [Migration and backup guide](database/MIGRATIONS.md)

## 8. Optional workstation tools

**Train a candidate model.** Install Python 3.12 with venv and pip support. From the repository root, create a separate environment and write candidate outputs outside the checkout.

```bash
python3.12 -m venv "$HOME/.venvs/iot-fan-ml"
"$HOME/.venvs/iot-fan-ml/bin/python" -m pip install -r ml/requirements.txt
candidate_dir=$(mktemp -d)
"$HOME/.venvs/iot-fan-ml/bin/python" ml/train_export.py --output-dir "$candidate_dir"
```

A successful export contains a dataset CSV, portable INT8 model, model manifest and two firmware headers under the candidate directory. Running the exporter without `--output-dir` writes into the checkout. Predictive accuracy on synthetic episodes measures the simulator task. For field evaluation, export JSONL from the admin dashboard and use the importer's session and label rules. [Model, import and training guide](ml/README.md)

**Recover saved Wi-Fi settings from a board you administer.** Close the serial monitor. Install the reader's dependencies in a separate environment and use the actual port.

```bash
python3.12 -m venv "$HOME/.venvs/iot-device"
"$HOME/.venvs/iot-device/bin/python" -m pip install -r tools/device/requirements.txt
"$HOME/.venvs/iot-device/bin/python" tools/device/pull_wifi_info.py --port /dev/ttyACM0
```

For the supplied partition table the reader uses offset `0x670000` and size `0x180000`. It writes saved SSIDs, plaintext Wi-Fi passwords and station IP information to the Git-ignored `local/device/wifi_info.json`. It replaces the output with an empty array and exits with status 1 if the board has no saved Wi-Fi list. Keep any previous export you need in private storage before running the command. Fan thresholds and the backend URL are separate settings.

## 9. Troubleshooting

- **Docker starts, but localhost:3000 refuses the connection.** Section 3 starts Node on the host. Section 7 keeps the backend inside Docker. Use the address and health command for the route you started.
- **Database login fails or required telemetry columns are missing.** Check the host/port for the chosen route and the credentials that initialized the volume. A rebuild reuses the volume. Follow the migration guide before applying updates to an existing database.
- **The UI opens but no device card appears.** Check the board's station IP, DNS/SNTP, backend URL and LAN reachability. A backend HTTP 401 on telemetry indicates a device key problem. After updating the firmware key, rebuild and upload the application. Restart the backend with the matching environment.
- **Device dashboard is missing after upload.** Confirm that both images were built for `yolo_uno` and that the filesystem image was uploaded. On a configured device, record settings before replacing it.
- **Serial port is busy or missing.** Close the monitor, check the cable, permissions and VM USB assignment, then rerun `pio device list`. Ports can change after reconnecting.
- **A ticket expires or AI stays on fallback.** Request a fresh ticket after checking the board clock, IP and shared device key. For AI, read the displayed decision reason. Check the seven-sample window, profile, score and sensor freshness before interpreting the relay state.

## 10. Preparing a public commit

The source tree includes the dashboard assets, SQL migrations, package lockfiles, board definition, two embedded model headers and model manifest. The training command can regenerate the synthetic CSV and standalone TFLite file outside the checkout. Keep private settings, Wi-Fi exports, database dumps and compiled firmware images on the machine where they are used.

From the repository root, preview what Git would stage. The first command lists the ignore rules. The second should return no paths on a source-only branch. The last two show the prospective changes and check the unstaged patch for whitespace errors.

```bash
git check-ignore -v .env firmware/include/secrets.h local/device/wifi_info.json .pio/build/yolo_uno/firmware.bin
git ls-files -- .env firmware/include/secrets.h local/ backups/ .pio/
git add --dry-run -A
git diff --check
```

After staging the intended files, review `git diff --cached --name-status`, `git diff --cached --check` and the content of `git diff --cached` in your own terminal. The two public templates are `.env.example` and `firmware/include/secrets.h.example`. Check that they contain only documentation and example values.

### Credentials used by an existing installation

If a working credential has ever appeared in a public example, commit or Wi-Fi export, rotate it where it grants access. An ignore rule or a later deletion leaves earlier commits accessible. If a history cleanup is also needed, coordinate it with anyone who already has a clone. [GitHub guidance on exposed credentials and repository history](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)

- **Device API key.** Put the same newly generated key in the server's private `.env` and each board's private header. Rebuild and upload the application to each board. Restart the host Node process or recreate the Compose backend to load the new value. Allow for a gap in uploads while the two sides use different keys. Confirm a fresh device reading and request a new dashboard ticket.
- **PostgreSQL password.** On an initialized Compose volume, the password belongs to the database role. Connect interactively using the command below. At the `psql` prompt run `\password` to set the current role's password, then `\q` to exit. Update `DB_PASS` in the private `.env` and restart the host Node process or run `docker compose up -d --force-recreate backend`. Check `/healthz` again. [PostgreSQL interactive password command](https://www.postgresql.org/docs/18/app-psql.html)

  ```bash
  docker compose exec postgres sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
  ```

- **Wi-Fi password.** Change an exposed network password at the router or access point, then reconnect affected boards with **Settings → WiFi**. Private USB exports can contain passwords for more than one saved network.
