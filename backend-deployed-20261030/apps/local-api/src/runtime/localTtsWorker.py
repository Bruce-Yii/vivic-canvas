"""Sherpa-ONNX dynamic Kokoro synthesis; PCM/WAV only, no audio device or files."""
import base64
import io
import json
import sys
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    setup = json.loads(sys.stdin.buffer.readline(16385))
    root = Path(setup["root"])
    if sherpa_onnx.__version__ != "1.12.32":
        raise RuntimeError("pinned Sherpa version required")
    kokoro = sherpa_onnx.OfflineTtsKokoroModelConfig(
        model=str(root / "model.onnx"), voices=str(root / "voices.bin"),
        tokens=str(root / "tokens.txt"), lexicon=str(root / "lexicon-zh.txt"),
        # KokoroMultiLangLexicon splits Han text into the Chinese lexicon;
        # `lang` selects eSpeak for NON-Chinese spans (e.g. Vivic), not the
        # speaker language. `zh` generated incompatible phonemes there.
        data_dir=str(root / "espeak-ng-data"), lang="en-us")
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(kokoro=kokoro, num_threads=2), max_num_sentences=1)
    if not config.validate():
        raise RuntimeError("invalid model config")
    engine = sherpa_onnx.OfflineTts(config)
    emit({"ready": True})
    while True:
        line = sys.stdin.buffer.readline(16385)
        if not line:
            return
        if len(line) > 16384:
            raise RuntimeError("request limit")
        message = json.loads(line)
        stage = "input_validation"
        try:
            text, speed = message["text"], message["speed"]
            if not isinstance(text, str) or not 1 <= len(text) <= 200 or not 0.5 <= speed <= 2:
                raise ValueError("bounded text and speed required")
            stage = "phonemization_or_inference"
            audio = engine.generate(text, sid=3, speed=speed)
            samples = np.asarray(audio.samples)
            stage = "audio_length"
            if audio.sample_rate != 24000 or not 2400 <= len(samples) <= 24000 * 45:
                raise ValueError("audio length limit")
            stage = "waveform_validation"
            if not np.isfinite(samples).all() or float(np.max(np.abs(samples))) < 0.001:
                raise ValueError("invalid waveform")
            output = io.BytesIO()
            with wave.open(output, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(audio.sample_rate)
                wav.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
            emit({"id": message["id"], "wav": base64.b64encode(output.getvalue()).decode("ascii")})
        except Exception as error:
            # Bounded classification only. Never emit text, phonemes or native
            # exception messages (which can contain the requested sentence).
            emit({"id": message["id"], "error": "synthesis_failed", "stage": stage,
                  "errorType": type(error).__name__[:60]})


if __name__ == "__main__":
    main()
