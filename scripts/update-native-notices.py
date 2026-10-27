#!/usr/bin/env python3
"""Regenerate native dependency inventory and distributed upstream license files."""
# SPDX-License-Identifier: AGPL-3.0-only
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
metadata = json.loads(subprocess.check_output([
    'cargo', 'metadata', '--locked', '--format-version', '1',
    '--manifest-path', str(ROOT / 'src-tauri/Cargo.toml'),
], text=True))
packages = sorted((p for p in metadata['packages'] if p.get('source')), key=lambda p: (p['name'], p['version']))
lines = [
    '# Native dependency inventory', '',
    'Generated from `src-tauri/Cargo.lock` by `scripts/update-native-notices.py`. Includes the resolved cross-platform and build dependency graph; an individual target links a subset.', '',
    'Upstream license files included in the downloaded crates are reproduced in [NATIVE_LICENSES.txt](NATIVE_LICENSES.txt). System libraries and OS frameworks retain their platform licenses.', '',
    '| Crate | Version | Declared license |', '| --- | --- | --- |',
]
texts = []
missing = []
for package in packages:
    name, version = package['name'], package['version']
    license_name = package.get('license') or 'See upstream license file'
    lines.append(f'| [{name}](https://crates.io/crates/{name}/{version}) | {version} | {license_name} |')
    directory = pathlib.Path(package['manifest_path']).parent
    paths = set()
    if package.get('license_file'):
        paths.add(directory / package['license_file'])
    for path in directory.iterdir():
        if path.is_file() and path.name.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'UNLICENSE')):
            paths.add(path)
    # Preserve supplemental notices in vendored native crypto/SQLite code.
    for child in ('third_party', 'third-party', 'src/ring', 'sqlite3'):
        folder = directory / child
        if folder.is_dir():
            for path in folder.rglob('*'):
                if path.is_file() and path.name.upper().startswith(('LICENSE', 'LICENCE', 'COPYING', 'NOTICE')):
                    paths.add(path)
    readable = []
    for path in sorted(paths):
        if path.is_file():
            value = path.read_text(errors='replace')
            readable.append(f'--- {path.relative_to(directory)} ---\n{value}')
    if not readable:
        missing.append(f'{name} {version} ({license_name})')
    texts.append(f'{"=" * 72}\n{name} {version}\nDeclared license: {license_name}\nhttps://crates.io/crates/{name}/{version}\n\n' + '\n\n'.join(readable))
if missing:
    texts.append('Packages without a separate license file in their Cargo source archive:\n' + '\n'.join(missing))
(ROOT / 'docs/NATIVE_DEPENDENCIES.md').write_text('\n'.join(lines) + '\n')
(ROOT / 'docs/NATIVE_LICENSES.txt').write_text('Multi Calendar native dependency license files\nGenerated from the locked Cargo graph.\n\n' + '\n\n'.join(texts) + '\n')
print(f'Wrote inventory for {len(packages)} crates and their packaged license files.')
