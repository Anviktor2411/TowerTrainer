# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec: one folder (or one file with --onefile) that carries server.py, the web/ page and the
# XRadio protocol module. Optional engines (edge-tts, piper, faster-whisper, vosk, av/opuslib) are picked
# up only when they are installed in the Python that runs PyInstaller.
#   pip install pyinstaller && pyinstaller TowerTrainer.spec
# The result in dist/TowerTrainer/ still downloads airports into its own cache/ next to the exe.
import os
block_cipher = None
root = os.path.abspath(".")
datas = [(os.path.join(root, "web"), "web"), (os.path.join(root, "xradio"), "xradio"), (os.path.join(root, "README.md"), "."), (os.path.join(root, "LICENSE"), ".")]
hidden = ["ws", "fsd", "tts", "stt", "navdata", "osm", "openflights", "aptdat", "opus_codec", "xradio_bridge", "setup", "sector"]
a = Analysis(["server.py"], pathex=[root], binaries=[], datas=datas, hiddenimports=hidden, hookspath=[], runtime_hooks=[],
             excludes=["tkinter", "matplotlib", "numpy.distutils"], cipher=block_cipher, noarchive=False)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="TowerTrainer", debug=False, bootloader_ignore_signals=False,
          strip=False, upx=False, console=True, icon=None)
coll = COLLECT(exe, a.binaries, a.zipfiles, a.datas, strip=False, upx=False, name="TowerTrainer")
