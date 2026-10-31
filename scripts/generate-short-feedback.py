"""Regenerate authored, bundled clips as files. Never open a playback device.

Use .cache/voice-assets-venv/bin/python with sherpa-onnx==1.12.32 and
numpy==2.3.3. Download sources at the pinned revisions documented alongside
the assets; model weights/tools stay in ignored .cache/, outside the app.
"""
import argparse
import hashlib
import json
import subprocess
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx

ROOT = Path(__file__).resolve().parent.parent
HASHES = {
    "model.onnx": "acc4adc175b9d9986106cd20060329673ad5a2e12ef3c557d2d3745b694f8b38",
    "voices.bin": "e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c",
    "tokens.txt": "931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14",
    "lexicon-zh.txt": "11111d8cd695fba2ace1367a1d0a708b586e6ef5c1f9be91da5d7eef129b651c",
}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, default=ROOT / ".cache/voice-assets")
    args = parser.parse_args()
    root = args.model_dir.resolve()
    out = ROOT / "apps/web/public/voice-feedback"
    out.mkdir(parents=True, exist_ok=True)
    for name, expected in HASHES.items():
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, f"Unexpected model file: {name}"
    assert sherpa_onnx.__version__ == "1.12.32"
    model = sherpa_onnx.OfflineTtsKokoroModelConfig(
        model=str(root / "model.onnx"), voices=str(root / "voices.bin"),
        tokens=str(root / "tokens.txt"), lexicon=str(root / "lexicon-zh.txt"),
        data_dir=str(root / "espeak-ng-data"), lang="zh",
    )
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(kokoro=model, num_threads=2), max_num_sentences=1,
    )
    assert config.validate()
    engine = sherpa_onnx.OfflineTts(config)
    files = []
    for name, text in [("checking", "我看看"), ("waiting", "稍等"), ("okay", "好的")]:
        result = engine.generate(text + "。", sid=3, speed=1.05)
        samples = np.asarray(result.samples)
        assert len(samples) > 2400 and np.max(np.abs(samples)) > 0.01
        wav = root / f"{name}.wav"
        with wave.open(str(wav), "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(result.sample_rate)
            writer.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
        mp3 = out / f"{name}.mp3"
        subprocess.run([
            "ffmpeg", "-v", "error", "-y", "-i", str(wav), "-af", "loudnorm=I=-20:TP=-3:LRA=7",
            "-ar", "24000", "-ac", "1", "-codec:a", "libmp3lame", "-b:a", "64k", str(mp3),
        ], check=True)
        files.append({"id": name, "text": text, "file": mp3.name, "bytes": mp3.stat().st_size,
                      "sha256": hashlib.sha256(mp3.read_bytes()).hexdigest(), "sampleRate": 24000,
                      "durationMs": round(len(samples) / result.sample_rate * 1000)})
    manifest = {"model": "hexgrad/Kokoro-82M-v1.1-zh", "modelRevision": "01e7505bd6a7a2ac4975463114c3a7650a9f7218",
                "onnxSource": "csukuangfj/kokoro-multi-lang-v1_1", "onnxRevision": "914313412b607d95400bcd12446233fbd1248801",
                "speaker": 3, "speed": 1.05,
                "generation": "sherpa-onnx 1.12.32 / numpy 2.3.3; offline file generation, no playback", "files": files}
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    (out / "MODEL-LICENSE.txt").write_bytes((root / "LICENSE").read_bytes())

if __name__ == "__main__":
    main()
