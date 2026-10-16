#!/usr/bin/env python3
"""Run portable firmware safety/policy checks with a host C++ compiler."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='iot-firmware-test-') as folder:
    binary = Path(folder) / 'input-safety'
    subprocess.run([
        os.environ.get('CXX', 'g++'), '-std=c++11', '-Wall', '-Wextra', '-Werror',
        '-I', str(root / 'firmware/include'),
        str(root / 'firmware/test/test_input_safety.cpp'), '-o', str(binary),
    ], check=True)
    subprocess.run([str(binary)], check=True)
print('Firmware sample freshness, frame bounds, rollover and risk boundaries: PASS')
