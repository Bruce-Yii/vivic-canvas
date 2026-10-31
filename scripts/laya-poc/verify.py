#!/usr/bin/env python3
"""Verify recorded evidence independently, without loading weights or using the network."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    cases = json.loads((HERE / 'cases.json').read_text())
    by_id = {c['id']: c for c in cases}
    assert len(by_id) == len(cases) == 36
    # Verify label isolation in the projection and question builder, with poisoned expectations.
    sys.path.insert(0, str(HERE))
    sys.dont_write_bytecode = True
    import benchmark
    import copy
    for c in cases:
        poison = copy.deepcopy(c)
        poison['expected'] = {'action': 'LABEL_SENTINEL', 'target': 'LABEL_SENTINEL'}
        state = benchmark.compact_canvas(poison)
        assert state == benchmark.compact_canvas(c)
        assert 'LABEL_SENTINEL' not in json.dumps(benchmark.questions(state))
    frozen = json.loads((ROOT / 'evidence/phase2-decision/pre-run-freeze.json').read_text())
    for f, expected in frozen['files'].items():
        assert sha(ROOT / f) == expected, 'Pre-run artifact changed: ' + f
    records = {}
    checks = []
    for run in ['cpu', 'mps']:
        directory = ROOT / 'evidence/phase2-decision' / run
        summary = json.loads((directory / 'summary.json').read_text())
        assert summary['status'] == 'MEASURED', summary
        rows = [json.loads(s) for s in (directory / 'predictions.jsonl').read_text().splitlines()]
        assert len(rows) == summary['predictions'] == 108
        assert summary['benchmark_sha256'] == sha(HERE / 'benchmark.py')
        assert summary['cases_sha256'] == sha(HERE / 'cases.json')
        assert Counter((r['case_id'], r['repeat']) for r in rows) == Counter(
            (c['id'], repeat) for c in cases for repeat in range(3))
        for r in rows:
            assert r['expected'] == by_id[r['case_id']]['expected']
            assert r['raw_correct'] == (r['predicted'] == r['expected'])
            assert r['latency_ms'] > 0
            assert r['state'] == benchmark.compact_canvas(by_id[r['case_id']], r['option_order_reversed'])
            assert r['questions'] == benchmark.questions(r['state'], r['option_order_reversed'])
            for key in ['action', 'target']:
                answer = r['result']['answers'][key]
                assert r['predicted'][key] in r['questions'][key]['criteria']
                assert answer['choice'] == r['predicted'][key]
                assert abs(sum(answer['probabilities'].values()) - 1) < .002
            assert r['result']['usage']['output_tokens'] == 0
        primary = [r for r in rows if r['repeat'] == 0]
        assert sum(r['raw_correct'] for r in primary) == summary['primary_correct']
        assert sum(r['raw_correct'] for r in rows) == summary['all_predictions_correct']
        assert len(json.loads((directory / 'failures.json').read_text())) == sum(not r['raw_correct'] for r in rows)
        records[run] = {(r['case_id'], r['repeat']): r for r in rows}
        checks.append({'run': run, 'status': 'PASS', 'predictions_verified': len(rows),
                       'truncated_requests': sum(r['result']['usage']['truncated'] for r in rows)})
    disagreements = [str(key) for key in records['cpu'] if
                     records['cpu'][key]['predicted'] != records['mps'][key]['predicted']]
    result = {'status': 'PASS', 'checks': checks,
              'cpu_mps_decision_disagreements': disagreements,
              'note': 'Evidence integrity PASS does not imply model accuracy or production readiness.'}
    dest = ROOT / 'evidence/phase2-decision/verification.json'
    dest.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
