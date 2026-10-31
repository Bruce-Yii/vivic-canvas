"""Generate licensed synthetic wake/command fixtures as files, without playback."""
import hashlib, importlib.util, json, wave
from pathlib import Path
import numpy as np
import sherpa_onnx
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('feedback', ROOT/'scripts/generate-short-feedback.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
model_dir = ROOT/'.cache/voice-assets'
for name, expected in module.HASHES.items():
    assert hashlib.sha256((model_dir/name).read_bytes()).hexdigest() == expected
assert sherpa_onnx.__version__ == '1.12.32'
model = sherpa_onnx.OfflineTtsKokoroModelConfig(model=str(model_dir/'model.onnx'), voices=str(model_dir/'voices.bin'), tokens=str(model_dir/'tokens.txt'), lexicon=str(model_dir/'lexicon-zh.txt'), data_dir=str(model_dir/'espeak-ng-data'), lang='zh')
engine = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(kokoro=model,num_threads=2), max_num_sentences=1))
out = ROOT/'evidence/next-plan/wake-fixtures'; out.mkdir(parents=True, exist_ok=True)
rows=[]
for speaker in [3,6,9]:
    for label, text in [('wake','vivic.'),('command','十分钟后提醒我喝水。')]:
        audio=engine.generate(text,sid=speaker,speed=1)
        samples=np.asarray(audio.samples)
        # Linear resampling suffices for an acoustic test fixture; no playback.
        at=np.arange(round(len(samples)*16000/audio.sample_rate))*audio.sample_rate/16000
        pcm=np.interp(at,np.arange(len(samples)),samples)
        target=out/f'{label}-{speaker}.wav'
        with wave.open(str(target),'wb') as writer:
            writer.setnchannels(1);writer.setsampwidth(2);writer.setframerate(16000)
            writer.writeframes((np.clip(pcm,-1,1)*32767).astype('<i2').tobytes())
        rows.append({'file':target.name,'text':text,'speaker':speaker,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'sampleRate':16000,'frames':len(pcm)})
(out/'manifest.json').write_text(json.dumps({'source':'Kokoro-82M-v1.1-zh; same pinned model/license as public/voice-feedback/manifest.json','synthetic':True,'playback':False,'microphone':False,'files':rows},ensure_ascii=False,indent=2))
print(json.dumps({'ok':True,'files':len(rows)}))
