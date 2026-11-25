"""Read the saved Wi-Fi list from a Yolo Uno over USB.

From the repository root, install tools/device/requirements.txt, close the serial
monitor and run this command with the port shown by `pio device list`:

    python tools/device/pull_wifi_info.py --port /dev/ttyACM0

The default offset and size match the spiffs entry used for LittleFS in the
board's default_8MB.csv partition table. For a custom layout, pass its values
in hexadecimal with --offset and --size. The output at local/device/wifi_info.json
contains plaintext passwords. A missing /wifi_list.json replaces it with an
empty array and exits with status 1. See GUIDE.md for setup and storage details.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
OUTPUT_PATH = os.path.join(PROJECT_ROOT, "local", "device", "wifi_info.json")

DEFAULT_OFFSET = "0x670000"
DEFAULT_SIZE = "0x180000"
DEFAULT_BAUD = "921600"

BLOCK_SIZE_CANDIDATES = [4096, 8192, 2048]

def run(cmd: list) -> None:
    print(">>", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stderr)
        sys.exit(result.returncode)

def try_mount(littlefs_mod, raw: bytes, size_int: int, block_size: int):
    try:
        block_count = size_int // block_size
        fs = littlefs_mod.LittleFS(block_size=block_size, block_count=block_count)
        fs.context.buffer = bytearray(raw)
        fs.mount()
        return fs
    except Exception:
        return None

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Read saved Wi-Fi credentials from ESP32 LittleFS into local/device/wifi_info.json"
    )
    parser.add_argument("--port", required=True, help="Serial port (e.g., /dev/ttyACM0 or COM7)")
    parser.add_argument(
        "--baud",
        default=DEFAULT_BAUD,
        help=f"Flash read baud rate (default: {DEFAULT_BAUD})",
    )
    parser.add_argument(
        "--offset",
        default=DEFAULT_OFFSET,
        help=f"LittleFS partition flash offset (default: {DEFAULT_OFFSET})",
    )
    parser.add_argument(
        "--size",
        default=DEFAULT_SIZE,
        help=f"LittleFS partition size in bytes (default: {DEFAULT_SIZE})",
    )
    args = parser.parse_args()

    try:
        import littlefs
    except ImportError:
        print("Missing dependency: pip install -r tools/device/requirements.txt")
        sys.exit(1)

    with tempfile.TemporaryDirectory() as tmpdir:
        fs_bin = os.path.join(tmpdir, "littlefs.bin")

        run(
            [
                sys.executable,
                "-m",
                "esptool",
                "--port",
                args.port,
                "--baud",
                args.baud,
                "read_flash",
                args.offset,
                args.size,
                fs_bin,
            ]
        )

        with open(fs_bin, "rb") as f:
            raw = f.read()

    size_int = int(args.size, 16)
    fs = None

    for bs in BLOCK_SIZE_CANDIDATES:
        fs = try_mount(littlefs, raw, size_int, bs)
        if fs is not None:
            break

    if fs is None:
        print(
            "Could not mount LittleFS image. Verify --offset and --size against your partition table."
        )
        sys.exit(1)

    # Read the Wi-Fi list
    try:
        with fs.open("/wifi_list.json", "r") as src:
            wifi_list = json.loads(src.read())
    except FileNotFoundError:
        print("No saved Wi-Fi list (/wifi_list.json) found on device.")
        fs.unmount()
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w", encoding="utf-8") as dst:
            dst.write("[]")
        sys.exit(1)

    # Read the current IP address and SSID
    sta_ip = ""
    current_ssid = ""
    try:
        with fs.open("/info.dat", "r") as src:
            info = json.loads(src.read())
            sta_ip = info.get("STA_IP", "")
            current_ssid = info.get("WIFI_SSID", "")
    except FileNotFoundError:
        pass

    # Unmount the filesystem after reading the data
    fs.unmount()

    # Load existing wifi_info.json to preserve previously recorded sta_ip values
    existing_map = {}
    if os.path.exists(OUTPUT_PATH):
        try:
            with open(OUTPUT_PATH, "r", encoding="utf-8") as f:
                existing = json.load(f)
            if isinstance(existing, list):
                for item in existing:
                    if item.get("ssid"):
                        existing_map[item["ssid"]] = item.get("sta_ip", "")
        except Exception:
            pass

    # Update sta_ip: set current SSID's IP from device, keep previous value for others
    for entry in wifi_list:
        if entry.get("ssid") == current_ssid:
            entry["sta_ip"] = sta_ip
        else:
            entry["sta_ip"] = existing_map.get(entry.get("ssid", ""), "")

    # Format the output JSON for better readability (add indent=4)
    content = json.dumps(wifi_list, ensure_ascii=False, indent=4)

    # Write the data to the configuration file
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as dst:
        dst.write(content)

    print("\nSaved Wi-Fi information to local/device/wifi_info.json")

if __name__ == "__main__":
    main()
