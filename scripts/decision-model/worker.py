"""Bounded, offline, choice-only inference. No sessions, tools or generation."""
import argparse, hashlib, json, os, sys, time
from pathlib import Path
HERE = Path(__file__).resolve().parent
args = argparse.ArgumentParser(); args.add_argument('--cache-dir', type=Path, required=True); cache = args.parse_args().cache_dir.resolve()
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',HF_HUB_DISABLE_IMPLICIT_TOKEN='1',TOKENIZERS_PARALLELISM='false',USE_TF='0',USE_FLAX='0',HF_HOME=str(cache/'hf'))
manifest = json.loads((HERE/'manifest.json').read_text())
def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for b in iter(lambda: stream.read(1024*1024),b''): h.update(b)
    return h.hexdigest()
for group, folder in [('sourceFiles','source'),('modelFiles','model')]:
    for row in manifest[group]:
        path=cache/folder/row['file']
        if path.stat().st_size!=row['bytes'] or digest(path)!=row['sha256']: raise RuntimeError('Fixed artifact verification failed')
sys.path.insert(0,str(cache/'source'))
def offline(event, args):
    if event in {'socket.connect','socket.connect_ex','urllib.Request'}: raise RuntimeError('Network prohibited during decision inference')
sys.addaudithook(offline)
import torch
torch.set_num_threads(2)
from kev import checkpoint as cp
original=cp.resolve_run
cp.resolve_run=lambda value: str(cache/'model/base') if str(value).rstrip('@')==str(cache/'model/base') else original(value)
cp.read_meta=lambda run: cp.Meta.from_dict(torch.load(str(Path(run)/'head.pt'),map_location='cpu',weights_only=True))
ck=cp.Checkpoint(str(cache/'model/adapter'));ck.meta.base=str(cache/'model/base');ck.meta.base_revision=None
tok,model=ck.load('mps',cp.LoadOptions(backend='mlx'))
import mlx.core as mx
mx.set_cache_limit(128*1024*1024)
OPTIONS=['fit: Show all existing cards and fit the canvas','restore: Restore the previous view or exit focus','focus: Focus or enlarge one existing card','delete: Remove an existing card','expand: Expand the text of an existing note','collapse: Collapse an existing note','other: Another request, ambiguous, negated, multiple operations, or insufficient information']
def score(text):
    record={'state':'User command: '+text,'questions':[{'instr':'Which single canvas operation does the user request? Select other if the user negates the operation or asks multiple operations.','options':OPTIONS,'label':0}]}
    enc=model.encode(tok,record,max_state=256,max_branch=512,strict=True)
    with torch.inference_mode(): return model.probs(enc)[0].tolist()
score('TEST warmup, do not perform any operation')
print(json.dumps({'ready':True,'backend':'mlx','gpuBytes':mx.get_active_memory(),'gpuPeakBytes':mx.get_peak_memory()}),flush=True)
for line in sys.stdin:
    if len(line.encode())>8192: break
    req = None
    try:
        req=json.loads(line)
        if set(req)!={'id','text'} or not isinstance(req['id'],int) or not isinstance(req['text'],str) or not 1<=len(req['text'])<=500: raise ValueError('Invalid input')
        start=time.perf_counter(); probabilities=score(req['text'])
        print(json.dumps({'id':req['id'],'probabilities':probabilities,'ms':round((time.perf_counter()-start)*1000,2)}),flush=True)
    except Exception:
        print(json.dumps({'id':req.get('id') if isinstance(req,dict) else 0,'error':'decision-unavailable'}),flush=True)
