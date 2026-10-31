#!/usr/bin/env python3
"""Two unchanged official examples; separate from frozen Vivic evaluation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import traceback

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for b in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, default=ROOT / '.cache/laya-poc')
    args = parser.parse_args()
    cache = args.cache_dir.resolve()
    os.environ.update(USE_TF='0', USE_FLAX='0', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                      HF_HUB_DISABLE_TELEMETRY='1', HF_HUB_DISABLE_IMPLICIT_TOKEN='1',
                      TOKENIZERS_PARALLELISM='false', HF_HOME=str(cache / 'hf'),
                      TORCH_HOME=str(cache / 'torch'), XDG_CACHE_HOME=str(cache / 'xdg'))
    def offline(event, audit_args):
        if event in {'socket.connect', 'socket.connect_ex', 'urllib.Request'}:
            raise RuntimeError('Sanity attempted network: ' + event)
    sys.addaudithook(offline)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(cache / 'source'))
    report = {'status': 'RUNNING', 'device': 'cpu', 'examples': [],
              'examples_sha256': sha(HERE / 'official-examples.json'),
              'note': 'No changes to frozen Vivic cases, prompts, thresholds, or recorded decisions. '
                      'Official examples retain their original input/question text; default prediction budgets.'}
    try:
        lock = json.loads((HERE / 'artifacts.lock.json').read_text())
        for name, expected in lock['source']['reviewed_files'].items():
            assert sha(cache / 'source' / name) == expected, name
        for entry in lock['model']['files']:
            assert sha(cache / 'model' / entry['path']) == entry['sha256'], entry['path']
        import torch
        import laya
        from laya.agent import _fix_tokenizer_config
        torch.set_num_threads(4)
        torch.set_num_interop_threads(1)
        runtime = cache / 'runtime-model'
        if not (runtime / 'model.safetensors').exists():
            raise RuntimeError('Run benchmark once to create derived runtime-model first')
        # Independently apply the upstream normalization to a fresh copy of original config.
        baseline = cache / 'sanity-tokenizer-upstream'
        (baseline / 'tokenizer').mkdir(parents=True, exist_ok=True)
        config = baseline / 'tokenizer/tokenizer_config.json'
        config.write_bytes((cache / 'model/tokenizer/tokenizer_config.json').read_bytes())
        _fix_tokenizer_config(str(baseline))
        same = json.loads(config.read_text()) == json.loads((runtime / 'tokenizer/tokenizer_config.json').read_text())
        if not same:
            raise RuntimeError('Derived tokenizer differs from upstream normalization')
        agent = laya.load(str(runtime), device='cpu', fast=False, compile=False, backend='eager')
        assert str(agent.device) == 'cpu'
        report['architecture'] = {
            'source_commit': lock['source']['commit'], 'model_revision': lock['model']['revision'],
            'encoder_class': type(agent.model.encoder).__name__,
            'encoder_layers': agent.model.encoder.config.num_hidden_layers,
            'head_layers': len(agent.model.head.layers),
            'hidden_size': agent.model.encoder.config.hidden_size,
            'tokenizer_class': type(agent.tok).__name__, 'tokenizer_vocab_size': agent.tok.vocab_size,
            'special_tokens': agent.tok.special_tokens_map,
            'mask_id': agent.tok.mask_token_id,
            'derived_config_matches_upstream': same,
            'rope_global': agent.model.encoder.config.global_rope_theta,
            'rope_local': agent.model.encoder.config.local_rope_theta,
            'weight_shapes': {k: list(v.shape) for k, v in agent.model.state_dict().items()
                              if k in ['type_emb.weight', 'scorer.weight', 'act_head.0.weight', 'act_head.2.weight']},
            'strict_checkpoint_load': True,
            'default_max_len': agent.cfg['max_len'], 'default_head_max_len': agent.cfg['head_max_len'],
        }
        # Public schema uses instructions+criteria; question is not an alias for instructions.
        try:
            agent.predict('test', {'q': {'type': 'choice', 'question': 'Which?', 'criteria': {'A': 'a', 'B': 'b'}}})
        except ValueError as exc:
            report['question_alias_negative_check'] = str(exc)
        else:
            raise RuntimeError('Unexpected support for question instead of instructions')
        for example in json.loads((HERE / 'official-examples.json').read_text()):
            start = time.perf_counter()
            result = agent.predict(example['state'], example['questions'])
            actual = result['answers']['department']['choice']
            report['examples'].append(dict(example, actual_department=actual,
                department_matches_official=actual == example['expected_department'],
                elapsed_ms=(time.perf_counter() - start) * 1000, result=result))
        report['status'] = 'PASS' if all(e['department_matches_official'] for e in report['examples']) else 'MISMATCH'
    except Exception as exc:
        report.update(status='BLOCKED', reason=type(exc).__name__ + ': ' + str(exc), traceback=traceback.format_exc())
    dest = ROOT / 'evidence/phase2-decision/official-sanity.json'
    dest.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'PASS' else 2


if __name__ == '__main__':
    sys.exit(main())
