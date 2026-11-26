# Getting started with IoT-Env-Monitor

> **Reference Environment & Exact Cloudflare Deployment Scope:** All coding, compilation, execution, TinyML training, USB flashing, hardware-in-the-loop (HIL) testing, and container/Wrangler management for this project (`project_linux` branch) were performed inside a **Linux Ubuntu virtual machine** (`sang@Linux`, Ubuntu LTS guest VM). **Only selected server/edge components are deployed onto Cloudflare**:
> - **Deployed via Cloudflare Workers + Workers VPC + Cloudflare Tunnel:** Container `iot_backend` (Express 5 on internal `3000/tcp` inside Docker network `iot_net` on the Ubuntu VM) is bridged outbound by `iot_cloudflared` (`cloudflare/cloudflared:2026.10.1`, tunnel `iot-env-monitor-sys` with **`1 VPC` route only**—no public tunnel hostname) to Cloudflare **Workers VPC** service `iot-env-backend` (`HTTP -> backend:3000`), which is exposed on `*.workers.dev` by Cloudflare Workers deployed via Wrangler (`iot-env-monitor-sys` and `iot-env-monitor` on `*.sangnguyen232.workers.dev`). This path serves `POST /sensor`, `/healthz`, `/login`, `/logout`, `/api/me`, and `/admin/*`.
> - **Kept strictly local (NOT deployed onto Cloudflare Tunnel):** ESP32-S3 firmware, sensor polling, on-device INT8 TinyML inference, GPIO10 relay control, the board's embedded web dashboard/WebSocket/OTA (`http://<board-lan-ip>/` and AP `192.168.4.1/` on the local Wi-Fi LAN), PostgreSQL 18 (`iot_postgres`, bound only to `iot_net:5432` and Ubuntu VM loopback `127.0.0.1:5433`), offline Python 3.12 TinyML training/import (`ml/`), and USB LittleFS recovery (`tools/device/`).

Choose a starting point based on what you are running on your **Linux Ubuntu VM** (or compatible Linux workstation):

- **Ubuntu VM software test (without hardware).** Clone the repository inside the Linux Ubuntu VM, then follow [the local backend walkthrough](#3-start-and-test-the-local-backend-without-a-board). It takes you from an empty PostgreSQL 18 container (`127.0.0.1:5433`) to a verified device card with one demonstration reading on `localhost:3000`.
- **Ubuntu VM and Yolo Uno ESP32-S3.** Pass the ESP32-S3 USB port through to the Ubuntu VM (`/dev/ttyACM0`), [build the two images locally](#4-prepare-the-board-configuration-and-compile), [upload and provision the board](#5-wire-upload-and-provision-the-esp32), then [check the LAN and admin dashboards](#6-check-the-dashboards-and-fan-control). The board monitors sensors, runs TinyML and controls the fan locally even without a backend or internet connection.
- **Selective Cloudflare deployment (Backend + Workers VPC + Tunnel) and local Python tools.** Use [the containerized backend and Cloudflare Worker VPC workflow](#7-deploy-the-containerized-stack-over-cloudflare-tunnel-on-the-linux-ubuntu-vm) to run `iot_postgres`, `iot_backend` and `iot_cloudflared` in Docker on the Ubuntu VM and publish `iot_backend:3000` through Workers VPC and `*.workers.dev`, or [the local Ubuntu VM Python workflows](#8-workstation-tools-on-the-linux-ubuntu-vm) to train a candidate model offline or read saved board Wi-Fi settings over USB. For a source release, see [Preparing a public commit](#10-preparing-a-public-commit).

## 1. Clone the project

Open a Bash terminal inside your **Linux Ubuntu virtual machine**, change to the directory where you keep your projects, and run the following commands. The paths and serial port examples (`/dev/ttyACM0`) match the Linux Ubuntu VM setup. (If adapting upload commands to Windows PowerShell, supply the board's COM port directly to PlatformIO, such as `--upload-port COM5`.) The shell variables and here-documents below use Bash syntax.

```bash
git clone --branch project_linux https://github.com/SangNguyen-232/IoT-Env-Monitor.git
cd IoT-Env-Monitor
git branch --show-current
```

The last command should print `project_linux`. Run each command block from this repository root inside the Linux Ubuntu VM unless it specifies another directory. Keep the source for the backend, Cloudflare Worker gateway, firmware and device dashboard on the same revision so that they agree on telemetry fields and control modes.

## 2. Choose the tools for your Linux Ubuntu VM setup

- **Docker Engine and Compose on the Ubuntu VM.** Install Docker Engine with Compose (`docker compose` plugin or `docker-compose`) inside the Linux Ubuntu VM and verify `docker info` and `docker compose version`. PostgreSQL 18 runs in Docker during local host-Node testing (section 3), while the deployed server stack (section 7) runs `iot_postgres`, `iot_backend` and `iot_cloudflared` together on internal bridge `iot_net`. [Docker installation on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- **JavaScript development and Wrangler on the Ubuntu VM.** Both `services/backend` and `services/gateway` specify Node `>=26.12.0 <27` and npm `>=12.2.0 <13`. With `nvm` installed in the Ubuntu VM, run `nvm install` and `nvm use` at the repository root to select `26.12.0` from `.nvmrc`. Check `node --version` and `npm --version`. If npm is outside the declared range, run `npm install --global npm@12.2.0` in that `nvm` environment. `iot_backend` builds its own Node runtime inside Docker, whereas `services/gateway` uses host Node/npm on the Ubuntu VM to bundle and deploy the Cloudflare Worker via Wrangler.
- **Local firmware toolchain on the Ubuntu VM (not deployed to Cloudflare).** Install PlatformIO Core (`pio --version`), or open the project with the PlatformIO IDE extension for VS Code inside the Linux Ubuntu VM. PlatformIO installs the pinned `espressif32@7.1.3` platform and Arduino libraries on the first build. Pass the Yolo Uno ESP32-S3 USB device from the host hypervisor into the Ubuntu guest VM so it attaches at `/dev/ttyACM0`. [PlatformIO Core installation](https://docs.platformio.org/en/latest/core/installation/methods/installer-script.html)
- **Cloudflare account credentials (for section 7 only).** Needed to register `iot_cloudflared` (`CLOUDFLARE_TUNNEL_TOKEN`), bind the HTTP Workers VPC Service (`iot-env-backend`), and deploy the Cloudflare Worker (`services/gateway/`) onto `*.workers.dev`.
- **Local Python 3.12 training and USB utilities on the Ubuntu VM (not deployed to Cloudflare).** Install `python3.12` and `python3.12-venv` on Ubuntu for section 8 (offline CPU TinyML training/export and local USB LittleFS Wi-Fi recovery). Firmware builds already include trained INT8 weights.

## 3. Start and test the local backend without a board

Choose a fresh lab database for a first local software check inside the Linux Ubuntu VM. The Compose project uses fixed container names and binds PostgreSQL (`iot_postgres`) to `127.0.0.1:5433` on the Ubuntu VM loopback. If the three-container stack (`iot_postgres`, `iot_backend`, `iot_cloudflared`) from section 7 is already running, check `docker compose ps` (or `docker-compose ps`) first. For an existing volume, review the migration and backup steps before starting a newer backend. [Database migrations](database/MIGRATIONS.md)

Create your private settings once on the Ubuntu VM. The conditional copy preserves an existing configuration.

```bash
test -f .env || (umask 077 && cp .env.example .env)
```

Open `.env` in your editor and set credentials for this installation. The public template leaves `SENSOR_API_KEY` empty. Use separate random values for the database password, session secret and device key. For example, `openssl rand -hex 32` generates one secret per invocation.

- Set `DB_HOST=127.0.0.1`, `DB_PORT=5433`, `DB_NAME`, `DB_USER` and `DB_PASS`. Compose passes matching credentials to PostgreSQL on its first initialization. Existing volumes keep their existing accounts and passwords.
- Set `SESSION_SECRET` for signed sessions and `SENSOR_API_KEY` for device telemetry and LAN tickets. Save the same newly generated device key in the firmware configuration in section 4. For a system already in use, follow the credential rotation notes in section 10.
- Set `ADMIN_USERNAME` and `ADMIN_PASSWORD`. The backend creates this account when the user table is empty. Editing these variables later does not reset an existing account.
- Set `SENSOR_RETENTION_DAYS` to the number of days to retain telemetry. The default is 30. The backend runs cleanup at startup and every six hours. Set it to 0 before collecting a session that you want to retain indefinitely.
- For this local host-Node check, leave a nonempty placeholder such as `unused-local` in `CLOUDFLARE_TUNNEL_TOKEN` (or supply your real tunnel token ahead of section 7). Compose validates the variable while reading `.env`, even when starting only `postgres`.

Start PostgreSQL in Docker, then run Express directly on the Linux Ubuntu VM. Keep this terminal open while testing.

```bash
docker compose config --quiet
docker compose up -d --wait postgres
(cd services/backend && npm ci && node --env-file=../../.env src/index.js)
```

Look for `API running on port 3000`. In a second Ubuntu VM terminal, run the following check and visit `http://localhost:3000/login`. Sign in with the admin credentials you supplied. A fresh database shows an empty device list until a device posts a reading.

```bash
curl -fsS http://127.0.0.1:3000/healthz
```

Expected response is `{"ok":true}`. This checks that Express on the Ubuntu VM can query PostgreSQL on `127.0.0.1:5433`. To test direct LAN uploads from a physical board without Cloudflare, set the Ubuntu VM network adapter to **Bridged** mode so the VM obtains an IP on the Wi-Fi LAN (such as `http://192.168.1.20:3000`) and allow TCP 3000 in `ufw` if active. When the Ubuntu VM uses NAT—or for remote HTTPS ingestion and `/admin/` access—deploy `iot_backend`, `iot_cloudflared` and the Cloudflare Worker VPC gateway in section 7 so the board posts over HTTPS to `*.workers.dev` without opening inbound VM ports. If port 3000 is busy during host-Node testing, prefix the command with `PORT=3001` and use that port for the browser, health check and demo sender. Keep the containerized backend on internal port 3000, which its health check and Workers VPC service (`backend:3000`) require.

**Optional ingestion check on a disposable lab database.** In the second Ubuntu VM terminal, change to the repository root and send one labeled demonstration reading to the locally running backend. The command uses the device key from your private environment and creates a row for `guide-demo`. If you supplied a custom port in the first terminal, also run `export PORT=3001` (using your port) in this terminal before sending.

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

Expect `200 OK` and a `guide-demo` card on the admin page after its next refresh. This exercises HTTP ingestion, persistence and listing on the Ubuntu VM with a known input.

To stop a local host-Node session before starting the containerized stack in section 7, press Ctrl+C in the backend terminal and run `docker compose stop postgres` in the project root. The named volume `fan_pgdata18` retains the data.

## 4. Prepare the board configuration and compile

Firmware and LittleFS assets are built locally inside the **Linux Ubuntu VM** and run strictly on the Yolo Uno ESP32-S3 (8 MB flash, `default_8MB.csv` partition layout, PlatformIO environment `yolo_uno`). From the repository root in the Ubuntu VM, create the private header once.

```bash
test -f firmware/include/secrets.h || (umask 077 && cp firmware/include/secrets.h.example firmware/include/secrets.h)
```

The example header supplies values for a compilation check. Before uploading an application image, edit the private copy with the values for this board. The application binary embeds those credentials.

- Set `SSID_AP` and `PASS_AP` for the board's local setup access point (`192.168.4.1`). Use a WPA2 passphrase of 8–63 ASCII characters.
- Set `DEVICE_HTTP_USER` and `DEVICE_HTTP_PASS` for direct local LAN (`http://<board-ip>/`) and ElegantOTA (`/update`) login. These belong strictly to the board on the LAN; the central admin account belongs to `iot_backend`.
- Set `SENSOR_API_KEY` to the exact key from `.env` on the Linux Ubuntu VM. Set `SENSOR_API_URL` to the deployed **Cloudflare Worker `*.workers.dev` HTTPS origin** (for example `https://iot-env-monitor-sys.sangnguyen232.workers.dev` or `https://<your-worker>.<your-subdomain>.workers.dev`, which routes `POST /sensor` through Workers VPC and Cloudflare Tunnel to `iot_backend:3000`), or to a bridged Ubuntu VM LAN IP (`http://192.168.1.20:3000`) during local-only bench checks. Note that the Cloudflare Tunnel itself has no public hostname (`Routes: 1 VPC`), so always use the Worker's `*.workers.dev` URL (or local LAN IP). The firmware appends `/sensor`. A saved URL in LittleFS `/server.json` takes precedence at startup.
- Use a trusted network. Device HTTP Basic credentials, the embedded LAN dashboard (`http://<board-ip>/`) and plain HTTP telemetry cross the LAN in clear text. For HTTPS uploads to `*.workers.dev`, the firmware client encrypts transport with `setInsecure()`, skipping server certificate verification.

Build the application and LittleFS dashboard filesystem separately inside the Linux Ubuntu VM.

```bash
pio run -e yolo_uno
pio run -e yolo_uno -t buildfs
```

Both commands should finish with `SUCCESS`. Look for `.pio/build/yolo_uno/firmware.bin` and `.pio/build/yolo_uno/littlefs.bin`. The filesystem image contains `dashboard.html`, `dashboard.css` and `dashboard.js` for the board's local port-80 web server. These commands leave the board untouched.

## 5. Wire, upload and provision the ESP32

With power disconnected, connect the DHT20 and 16×2 LCD to the shared I²C bus, SDA on GPIO11 and SCL on GPIO12. The firmware uses LCD address `0x27`. The optional soil probe connects to GPIO2. Keep sensor signals within the board's input ratings. The status LED uses GPIO48 and the onboard NeoPixel uses GPIO45. GPIO10 is an active-high relay control signal. Power the fan through a suitably rated driver and supply. The dashboard reports the GPIO command. To verify fan motion you need a separate observation.

Connect the board with a data-capable USB cable and pass the USB device through from your hypervisor to the **Linux Ubuntu virtual machine** (for example, adding a persistent USB filter in VirtualBox so the Yolo Uno ESP32-S3 automatically reattaches to the Ubuntu guest across resets). Inside the Ubuntu VM, run `pio device list` and inspect the device group with `ls -l /dev/ttyACM0`. If the group is `dialout`, an Ubuntu user without access can run `sudo usermod -aG dialout "$USER"` and sign out and back in to the VM session. Close any program holding `/dev/ttyACM0` before uploading.

**Before uploading LittleFS to a board already in use**, record the Wi-Fi, backend URL and fan settings you will need again. `uploadfs` replaces the filesystem, including the saved settings. Use it on first installation and when updating the dashboard assets. A normal application upload with the same partition layout preserves those files. The application enables automatic formatting if LittleFS fails to mount at startup.

```bash
board_port=/dev/ttyACM0   # Substitute the port reported by pio device list in the Ubuntu VM.
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
2. Under **Settings → WiFi**, enter the router's 2.4 GHz SSID and password, confirm the **Backend URL** (your Cloudflare Worker `https://<worker>.<subdomain>.workers.dev` URL or local bridged Ubuntu VM IP), then choose **Save & connect**. Saving a new SSID restarts the board. Rejoin the router's network.
3. Find `STA Mode IP address:` in the serial monitor. Open `http://<board-ip>/` in a browser on the **same local Wi-Fi LAN** using the board's HTTP credentials (this embedded dashboard is LAN-only and is never served through Cloudflare). When saved Wi-Fi is unavailable, the device provides the setup access point and periodically retries the saved network.
4. Allow DNS and network time synchronization. The board uses `pool.ntp.org` and `time.nist.gov` and starts posting timestamped telemetry to `/sensor` once its clock is valid. Visit the central admin page (at `https://<worker>.<subdomain>.workers.dev/admin/` or locally on the Ubuntu VM). The device card should now show its MAC, LAN IP and live readings.
5. For later browser-based firmware updates on the local LAN, the board serves ElegantOTA at `http://<board-ip>/update`. Use the device credentials and select the image type matching your file. A filesystem OTA update also replaces device settings. Holding the BOOT button on GPIO0 for more than two seconds while the application is running clears saved network, backend and fan settings.

## 6. Check the dashboards and fan control

The central admin page at `/admin/` (published via the Cloudflare Worker `*.workers.dev` gateway backed by Workers VPC + Cloudflare Tunnel -> `iot_backend` on the Linux Ubuntu VM) lists devices and exports per-device history as JSONL. By contrast, the embedded device dashboard at `http://<board-ip>/` runs **strictly on the board's local Wi-Fi LAN** and provides live WebSocket readings plus separate Wi-Fi, FAN and TinyML settings. When an operator clicks **Open dashboard** on `/admin/`, `iot_backend` issues a 5-minute HMAC ticket bound to the board MAC and LAN IP, and the browser connects **directly over LAN** to `http://<board-ip>/?ticket=...` (so the browser must be on the Wi-Fi LAN—either on the host OS or inside a Bridged Ubuntu VM). An administrator can use **Create user** and **Assign access** to grant a user access to a specific device and LAN IP. A user who opens an authorized board enters its device password or requests administrator approval when no password has been set. Direct board login uses the separate HTTP credentials from the firmware header.

1. Check the local LAN dashboard and LCD for temperature and humidity. Samples arrive about every five seconds. Soil readings are independent. The endpoints of the soil ADC range (0 and 4095) produce an unavailable reading.
2. In **Settings → Fan**, enter ON and OFF thresholds for both temperature (−40 to 80 °C) and relative humidity (0 to 100%), choose OR or AND, then select **Save fan settings**. Select a mode and choose **Apply**. Each OFF value must be below its ON value. Until this is done, AUTO keeps the relay off and requests for SHADOW or AI receive HTTP 409.
3. Use **AUTO** to check the saved hysteresis. OR turns on when either upper threshold is reached and turns off when both lower thresholds are reached. AND turns on when both upper thresholds are reached and turns off when either lower threshold is reached. Normal automatic transitions observe a ten-second dwell. Invalid or stale DHT readings force automatic shutoff.
4. Use **SHADOW** to compare the model proposal with the rule-driven relay command in **Settings → TinyML**. For the shipped model, set temperature ON/OFF to 30/28 °C, humidity ON/OFF to 75/70% and logic to OR before trying **AI**. Seven consecutive in-domain readings are needed for a forecast. With a matching profile and sufficient score (at least 0.80), AI can start the fan early inside the hysteresis band. Other profiles use your saved rules as fallback.
5. **MANUAL** accepts direct ON/OFF requests and limits a continuous run to five minutes. A reboot selects AUTO and reloads the saved thresholds. For physical trials, record the sample sequence, applied fan reason and observed relay or fan response. [Hardware bench procedures](ml/HIL.md)

To verify ingestion inside the Linux Ubuntu VM, inspect the latest rows in `iot_postgres` locally with this read-only query. Compare the device identifier and sequence with the serial output and the exported history.

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT received_at, device_id, sample_seq, temperature, humidity,
       "FAN_state", "MODE_state", fan_reason
FROM sensor_logs ORDER BY id DESC LIMIT 5;
SQL
```

## 7. Deploy the containerized stack over Cloudflare Tunnel on the Linux Ubuntu VM

Use this workflow inside the **Linux Ubuntu virtual machine** to deploy the server-side origin and Cloudflare edge gateway. Stop any directly running host Node process from section 3 first.

**Exact deployment scope:** In [docker-compose.yml](docker-compose.yml), three containers run on internal Docker network `iot_net` inside the Ubuntu VM:
- `iot_postgres` (`postgres:18.6-alpine3.24`) binds `127.0.0.1:5433->5432/tcp` **only on the Ubuntu VM loopback** and `postgres:5432` internally on `iot_net` (never exposed to Cloudflare).
- `iot_backend` (`iot-env-monitor-backend`) exposes `3000/tcp` **only inside `iot_net`** (`TRUST_PROXY=1`, no host port published).
- `iot_cloudflared` (`cloudflare/cloudflared:2026.10.1`) opens outbound Cloudflare Tunnel `iot-env-monitor-sys` with **no public tunnel hostname** (`Routes: 1 VPC` only), bridging **Workers VPC** service `iot-env-backend` (`HTTP -> backend:3000`) to public Cloudflare Workers on `*.workers.dev` (`services/gateway/`).

1. **Configure Cloudflare Tunnel and Workers VPC Service.**
   - In the Cloudflare dashboard (**Networks → Tunnels**), create a `cloudflared` tunnel (named `iot-env-monitor-sys` in the reference setup) and place its token into `CLOUDFLARE_TUNNEL_TOKEN` in `.env` on the Linux Ubuntu VM. Do **not** add a public hostname route if keeping the reference Workers VPC-only setup (`Routes: 1 VPC`).
   - Under **Workers & Pages → Workers VPC**, create an **HTTP** VPC Service (named `iot-env-backend` in the reference setup) attached to tunnel `iot-env-monitor-sys`, with **Host** `backend` and **Port** `3000` (`HTTP:3000`). `iot_cloudflared` resolves `backend` directly over `iot_net`.
   - Copy the generated VPC **Service ID** (for example `01a13b15-2978-7a33-963b-441c3925539c` in [services/gateway/wrangler.jsonc](services/gateway/wrangler.jsonc)) into `vpc_services[0].service_id`, keeping `"binding": "IOT_BACKEND"` and `"workers_dev": true`. Set `"name"` to your Worker name (such as `"iot-env-monitor-sys"`). [Cloudflare Workers VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)
2. **Start and verify the three containers on the Linux Ubuntu VM.** PostgreSQL and the backend define container health checks (`(healthy)`), while `iot_cloudflared` registers 1 healthy tunnel replica (`2026.10.1`):

```bash
docker compose up -d --build
docker compose ps          # or: docker-compose ps
docker compose logs --tail=30 cloudflared
docker compose exec -T backend node -e 'fetch("http://127.0.0.1:3000/healthz").then(async r => { console.log(r.status, await r.text()); process.exitCode = r.ok ? 0 : 1 })'
```

Confirm in the Cloudflare dashboard that Tunnel `iot-env-monitor-sys` (`1 VPC`) and Workers VPC Service `iot-env-backend` (`HTTP:3000`) both show **`Healthy`**.

3. **Deploy the Cloudflare Worker gateway onto `*.workers.dev` from the Ubuntu VM.** With Node `26.12.0` / npm `12.2.0` active in the Ubuntu VM, validate the Worker bundle and publish via Wrangler:

```bash
(cd services/gateway && npm ci && npx wrangler deploy --dry-run)
(cd services/gateway && npx wrangler login && npm run deploy)
```

Wrangler publishes `https://<worker-name>.<your-subdomain>.workers.dev` (in the reference deployment, `iot-env-monitor-sys.sangnguyen232.workers.dev`—plus companion Worker `iot-env-monitor.sangnguyen232.workers.dev` bound to the same `IOT_BACKEND` VPC Service `iot-env-backend`, with no custom domain and no Zero Trust Access gate).

4. **Verify end-to-end Worker -> VPC -> Tunnel -> Backend routing.** Open `https://<worker-name>.<your-subdomain>.workers.dev/healthz` (expect `{"ok":true}`) and `/login` to verify that Cloudflare Worker `IOT_BACKEND` reaches `iot_backend:3000` and `iot_postgres` inside the Ubuntu VM. Configure the ESP32-S3 (`SENSOR_API_URL` in `secrets.h` or **Settings → WiFi** on `http://<board-ip>/`) to send `POST /sensor` telemetry to that `https://*.workers.dev` origin. (`npm run dev` in `services/gateway` also supports Wrangler remote-VPC dev mode from the Ubuntu VM.) Remember that PostgreSQL (`127.0.0.1:5433`) and the ESP32's local web server (`http://<board-ip>/`) remain strictly local and are not accessible via `*.workers.dev`.
5. `docker compose stop` on the Ubuntu VM pauses the three containers while retaining `fan_pgdata18` (with `restart: unless-stopped`, running containers automatically resume when the Ubuntu VM starts). For an older database, follow the backup and migration instructions. First initialization loads the base schema, then migrations 001, 003, 004 and 005. Migration 002 is for legacy timestamp conversion. [Migration and backup guide](database/MIGRATIONS.md)

## 8. Workstation tools on the Linux Ubuntu VM

Both Python workflows below run **strictly offline/locally** inside the **Linux Ubuntu virtual machine** and are never containerized or deployed to Cloudflare.

**Train a candidate model locally on the Ubuntu VM.** Ensure Python 3.12 with `venv` and `pip` support (`python3.12-venv`) is installed in the Linux Ubuntu VM. From the repository root, create an isolated environment and write candidate outputs outside the checkout.

```bash
python3.12 -m venv "$HOME/.venvs/iot-fan-ml"
"$HOME/.venvs/iot-fan-ml/bin/python" -m pip install -r ml/requirements.txt
candidate_dir=$(mktemp -d)
"$HOME/.venvs/iot-fan-ml/bin/python" ml/train_export.py --output-dir "$candidate_dir"
```

A successful export contains a dataset CSV, portable INT8 model, model manifest and two C firmware headers under the candidate directory (to be compiled locally into ESP32-S3 firmware via `pio run`). Running the exporter without `--output-dir` writes into the checkout. Predictive accuracy on synthetic episodes measures the simulator task. For field evaluation on the Ubuntu VM, export JSONL from `/admin/` (via `*.workers.dev` or local backend) and run `ml/import_history.py` locally. [Model, import and training guide](ml/README.md)

**Recover saved Wi-Fi settings locally over Ubuntu VM USB passthrough.** Close any open serial monitor on the Ubuntu VM, confirm `/dev/ttyACM0` is passed through from the hypervisor, and install the reader's dependencies in a separate environment.

```bash
python3.12 -m venv "$HOME/.venvs/iot-device"
"$HOME/.venvs/iot-device/bin/python" -m pip install -r tools/device/requirements.txt
"$HOME/.venvs/iot-device/bin/python" tools/device/pull_wifi_info.py --port /dev/ttyACM0
```

For the supplied partition table the reader uses offset `0x670000` and size `0x180000`. It writes saved SSIDs, plaintext Wi-Fi passwords and station IP information to the Git-ignored local path `local/device/wifi_info.json`. It replaces the output with an empty array and exits with status 1 if the board has no saved Wi-Fi list. Keep any previous export you need in private storage before running the command. Fan thresholds and the backend URL are separate settings.

## 9. Troubleshooting (Linux Ubuntu VM, LAN & Cloudflare Workers VPC)

- **Docker runs on the Ubuntu VM, but `localhost:3000` refuses the connection.** Section 3 starts Node directly on the Ubuntu VM host (`localhost:3000`). Section 7 keeps `iot_backend` internal to `iot_net` (`3000/tcp` with no published host port) so only `iot_cloudflared` / Workers VPC reaches `http://backend:3000`. Test inside the container (`docker compose exec -T backend ...`) or via `https://<worker>.<subdomain>.workers.dev/healthz`.
- **The `*.workers.dev` URL returns HTTP 502 (`IoT Backend Unavailable`).** `services/gateway/src/index.js` returns 502 when `env.IOT_BACKEND.fetch(...)` fails. Inside the Ubuntu VM, inspect `docker compose ps` (`docker-compose ps`) and `docker compose logs --tail=50 cloudflared` to confirm `iot_backend` is `(healthy)` and `iot_cloudflared` registered tunnel `iot-env-monitor-sys`. In the Cloudflare dashboard, verify Tunnel status (`Healthy`, `1 VPC`), Workers VPC Service `iot-env-backend` (`HTTP`, host `backend`, port `3000`, `Healthy`), and that `service_id` in `services/gateway/wrangler.jsonc` matches before redeploying with `npx wrangler deploy`.
- **Database login fails or required telemetry columns are missing.** Remember PostgreSQL is never exposed on Cloudflare: host tools on the Ubuntu VM connect to `127.0.0.1:5433`, whereas `iot_backend` in Compose connects to `postgres:5432`. Check the credentials that initialized `fan_pgdata18` and follow [database/MIGRATIONS.md](database/MIGRATIONS.md) before upgrading an existing database.
- **`/admin/` opens on `*.workers.dev`, but no device card appears or **Open dashboard** cannot reach the board.** Check the board's station IP, DNS/SNTP sync, `SENSOR_API_URL` (must be your `https://<worker>.<subdomain>.workers.dev` URL, not a tunnel name) and `SENSOR_API_KEY` (HTTP 401 on `POST /sensor` indicates a key mismatch). Because the ESP32's web server (`http://<board-lan-ip>/`) is **LAN-only** and not routed through Cloudflare Tunnel, **Open dashboard** works only from a browser with direct Wi-Fi LAN reachability to `<board-lan-ip>` (use a host browser on the same Wi-Fi network, or configure the Ubuntu VM network adapter in Bridged mode).
- **Device dashboard is missing after upload.** Confirm that both images were built locally for `yolo_uno` on the Ubuntu VM and that `uploadfs` was run. On a configured device, record settings before replacing LittleFS.
- **Serial port `/dev/ttyACM0` is busy or missing in the Ubuntu VM.** Close `pio device monitor`, check the USB cable, verify `dialout` group membership (`id -nG`), and add a persistent USB device filter in your VM hypervisor so ESP32 resets automatically reattach to the Linux Ubuntu guest. Rerun `pio device list` in case the port re-enumerated.
- **A ticket expires or AI stays on fallback.** Request a fresh ticket after checking SNTP time sync on both the Ubuntu VM and ESP32-S3, the board LAN IP and the shared device key. For AI, read the displayed decision reason and check the seven-sample window, OR 30/28 °C & 75/70% RH profile, peak score (`>= 0.80`) and sensor freshness.

## 10. Preparing a public commit

The source tree on `project_linux` includes the dashboard assets, SQL migrations, package lockfiles, board definition, two embedded model headers and model manifest. The offline training command on the Linux Ubuntu VM can regenerate the synthetic CSV and standalone TFLite file outside the checkout. Keep private `.env` settings, `CLOUDFLARE_TUNNEL_TOKEN`, Wi-Fi exports, database dumps and compiled firmware images private inside your VM.

From the repository root on the Linux Ubuntu VM, preview what Git would stage. The first command lists the ignore rules. The second should return no paths on a source-only branch. The last two show the prospective changes and check the unstaged patch for whitespace errors.

```bash
git check-ignore -v .env firmware/include/secrets.h local/device/wifi_info.json .pio/build/yolo_uno/firmware.bin
git ls-files -- .env firmware/include/secrets.h local/ backups/ .pio/
git add --dry-run -A
git diff --check
```

After staging the intended files, review `git diff --cached --name-status`, `git diff --cached --check` and the content of `git diff --cached` in your Ubuntu VM terminal. The two public templates are `.env.example` and `firmware/include/secrets.h.example`. Check that they contain only documentation and example values.

### Credentials used by an existing installation

If a working credential (including `CLOUDFLARE_TUNNEL_TOKEN`, `SENSOR_API_KEY`, or a database/Wi-Fi password) has ever appeared in a public example, commit or Wi-Fi export, rotate it where it grants access. An ignore rule or a later deletion leaves earlier commits accessible. If a history cleanup is also needed, coordinate it with anyone who already has a clone. [GitHub guidance on exposed credentials and repository history](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)

- **Cloudflare Tunnel token.** Rotate or refresh the tunnel token for `iot-env-monitor-sys` in the Cloudflare dashboard, update `CLOUDFLARE_TUNNEL_TOKEN` in `.env` on the Linux Ubuntu VM, and run `docker compose up -d --force-recreate cloudflared`.
- **Device API key.** Put the same newly generated key in the Ubuntu VM's private `.env` and each board's private `firmware/include/secrets.h`. Rebuild and upload the application locally to each board from the Ubuntu VM. Restart the host Node process or recreate `iot_backend` (`docker compose up -d --force-recreate backend`) to load the new value. Allow for a gap in uploads while the two sides use different keys. Confirm a fresh device reading on `*.workers.dev/admin/` and request a new LAN dashboard ticket.
- **PostgreSQL password.** On an initialized Compose volume on the Ubuntu VM, the password belongs to the database role. Connect interactively using the command below. At the `psql` prompt run `\password` to set the current role's password, then `\q` to exit. Update `DB_PASS` in the private `.env` and restart the host Node process or run `docker compose up -d --force-recreate backend`. Check `/healthz` again. [PostgreSQL interactive password command](https://www.postgresql.org/docs/18/app-psql.html)

  ```bash
  docker compose exec postgres sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
  ```

- **Wi-Fi password.** Change an exposed network password at the router or access point, then reconnect affected boards locally via **Settings → WiFi**. Private USB exports can contain passwords for more than one saved network.
