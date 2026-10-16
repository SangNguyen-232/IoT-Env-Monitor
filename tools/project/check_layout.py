#!/usr/bin/env python3
"""Validate repository paths without installing firmware or service dependencies."""
from __future__ import annotations
import configparser
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def is_deferred_markdown(path: Path) -> bool:
    if path.suffix.lower() != '.md':
        return False
    # --no-index includes tracked README files covered by the temporary policy.
    result = subprocess.run(
        ['git', 'check-ignore', '--no-index', '--quiet', '--', str(path.relative_to(ROOT))],
        cwd=ROOT, check=False,
    )
    require(result.returncode in (0, 1), f'Cannot check documentation policy: {path}')
    return result.returncode == 0


def main() -> int:
    config = configparser.ConfigParser(interpolation=None)
    config.read(ROOT / 'platformio.ini')
    expected = {
        'src_dir': 'firmware/src', 'include_dir': 'firmware/include',
        'lib_dir': 'firmware/lib', 'boards_dir': 'firmware/boards',
        'data_dir': 'firmware/data', 'test_dir': 'firmware/test',
    }
    for key, value in expected.items():
        require(config['platformio'].get(key) == value, f'Unexpected PlatformIO {key}')
        require((ROOT / value).is_dir(), f'Missing {value}')
    require((ROOT / 'firmware/boards/yolo_uno.json').is_file(), 'Missing target board')
    print('PlatformIO directory configuration: OK')

    paths = json.loads((ROOT / 'docs/architecture/path-map.json').read_text())
    for before, after in paths.items():
        if is_deferred_markdown(ROOT / after):
            continue
        require((ROOT / after).exists(), f'Moved path missing: {before} -> {after}')
    own_headers = {p.name for p in (ROOT / 'firmware/include').rglob('*.h')}
    own_headers.add('secrets.h')  # Local file is intentionally absent on a clean clone.
    for source in [*(ROOT / 'firmware/src').rglob('*.cpp'), *(ROOT / 'firmware/include').rglob('*.h')]:
        if source.name == 'secrets.h':
            continue
        for header in re.findall(r'#\s*include\s*[<"]([^>"\n]+)[>"]', source.read_text()):
            if '/' in header:
                target = ROOT / 'firmware/include' / header
                # External SDK and TensorFlow includes are resolved by PlatformIO.
                if header.split('/')[0] in {x.name for x in (ROOT / 'firmware/include').iterdir() if x.is_dir()}:
                    require(target.is_file() or header == 'config/secrets.h', f'{source}: unresolved project include {header}')
            else:
                require(header not in own_headers, f'{source}: project include lacks module prefix: {header}')
    print('Source move map and module includes: OK')

    for folder in ('services/backend', 'services/gateway'):
        package = json.loads((ROOT / folder / 'package.json').read_text())
        lock = json.loads((ROOT / folder / 'package-lock.json').read_text())
        require(package['name'] == lock['packages']['']['name'] == lock['name'], f'{folder}: package names disagree')
        for key in ('dependencies', 'devDependencies', 'engines'):
            require(package.get(key, {}) == lock['packages'][''].get(key, {}), f'{folder}: lockfile disagrees on {key}')
        if 'main' in package:
            require((ROOT / folder / package['main']).is_file(), f'{folder}: missing entry point')
    require((ROOT / 'services/backend/public/admin/admin.html').is_file(), 'Missing admin assets')
    require((ROOT / 'services/backend/public/login/login.html').is_file(), 'Missing login assets')
    print('Service entry points, assets and package lockfiles: OK')

    model = (ROOT / 'ml/models/dht_risk_model.tflite').read_bytes()
    text = (ROOT / 'firmware/include/generated/dht_risk_model.h').read_text()
    embedded = bytes(int(x, 16) for x in re.findall(r'0x([0-9a-fA-F]{2})', text))
    require(model == embedded, 'Exported model/header mismatch')
    print('Versioned TFLite model and generated header: OK')

    docs = [ROOT / 'README.md', ROOT / 'docs/README.md',
            *(ROOT / 'docs/architecture').glob('*.md'), *(ROOT / 'docs/development').glob('*.md')]
    checked_docs = 0
    for doc in docs:
        if is_deferred_markdown(doc):
            continue
        for url in re.findall(r'\]\(([^)]+)\)', doc.read_text()):
            url = url.split('#')[0]
            if url and '://' not in url and not url.startswith(('mailto:', 'data:')):
                if is_deferred_markdown((doc.parent / url).resolve()):
                    continue
                require((doc.parent / url).exists(), f'{doc}: broken link {url}')
        checked_docs += 1
    if checked_docs:
        print('Canonical documentation links: OK')
    else:
        print('Canonical documentation links: deferred (Markdown excluded by Git policy)')

    result = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=ROOT,
                            text=True, capture_output=True, check=True)
    for filename in result.stdout.splitlines():
        if not (ROOT / filename).exists():
            continue  # The move may not yet be staged.
        require(not filename.startswith(('local/', 'backups/', '.pio/', '.venv/')), f'Private/generated path visible to Git: {filename}')
        require(filename not in ('.env', 'firmware/include/config/secrets.h', 'include/secrets.h', 'data/wifi_info.json'), f'Secret visible to Git: {filename}')
    print('Local configuration and work products excluded from Git: OK')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print(f'Layout check failed: {error}', file=sys.stderr)
        sys.exit(1)
