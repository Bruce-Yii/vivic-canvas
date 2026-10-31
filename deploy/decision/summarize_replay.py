"""Normalize timing names from raw replay rows without changing predictions or labels."""
import json
import math
import sys
from pathlib import Path


def percentile(values, p):
    if not values: return None
    values = sorted(values)
    return values[max(0, math.ceil(len(values) * p) - 1)]


path = Path(sys.argv[1])
value = json.loads(path.read_text())
traces = [r['shadow']['trace'] for r in value['rows'] if r['shadow'].get('trace')]
complete = [t for t in traces if t['status'] != 'pending']
value['routeP50Ms'] = percentile([t['routeLatencyMs'] for t in complete], .5)
value['routeP95Ms'] = percentile([t['routeLatencyMs'] for t in complete], .95)
value['decisionP50Ms'] = percentile([t['latencyMs'] for t in complete], .5)
value['decisionP95Ms'] = percentile([t['latencyMs'] for t in complete], .95)
value['timingDefinitions'] = {'route': 'first clause route HTTP round trip',
    'decision': 'all read-only classification/target/clauses, independent of legacy planner duration'}
if len(sys.argv) > 2:
    dataset = json.loads(Path(sys.argv[2]).read_text())
    rows = {r['id']: r for r in value['rows']}
    target_rows, target_errors = 0, []
    for case in dataset['cases']:
        if not case.get('target') or case['id'] not in rows: continue
        target_rows += 1
        target = (rows[case['id']]['shadow'].get('trace') or {}).get('target') or {}
        actual = target.get('targetId') or ('missing' if target.get('missing') else 'ambiguous' if 'ambiguous' in target else None)
        if actual != case['target']: target_errors.append({'id': case['id'], 'expected': case['target'], 'actual': actual})
    value['targetSamples'] = target_rows
    value['targetAccuracy'] = (target_rows - len(target_errors)) / target_rows if target_rows else None
    value['targetErrors'] = target_errors
path.write_text(json.dumps(value, ensure_ascii=True, indent=2) + '\n')
path.chmod(0o600)
print(json.dumps({k: v for k, v in value.items() if k != 'rows'}))
