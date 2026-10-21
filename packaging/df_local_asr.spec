# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).resolve().parent

a = Analysis(
    [str(ROOT / 'local_asr' / 'run.py')],
    pathex=[str(ROOT / 'local_asr')],
    binaries=[],
    datas=[(str(ROOT / 'local_asr' / 'config.example.json'), '.')],
    hiddenimports=collect_submodules('faster_whisper') + [
        'ctranslate2', 'fsspec', 'fsspec.callbacks', 'fsspec.config', 'fsspec.utils',
        'uvicorn.logging', 'uvicorn.loops.auto', 'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets.auto', 'uvicorn.lifespan.on',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['torch', 'pandas', 'scipy', 'matplotlib', 'IPython', 'pytest', 'jupyter', 'notebook', 'PIL', 'pygame', 'tensorflow', 'keras', 'imageio', 'soundfile', 'librosa', 'sklearn', 'cv2'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='df_local_asr',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='df_local_asr',
)
