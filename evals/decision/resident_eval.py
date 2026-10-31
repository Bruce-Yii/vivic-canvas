"""Re-run the frozen dataset through the resident Metal 4B service on the Mac.

Does not start, stop or reconfigure a model. Credentials stay on the model host.
Usage on the Mac: python resident_eval.py --output results/g-resident.json
"""
import argparse
import hashlib
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LAB = Path.home() / 'vivic-decision-lab'
ROOT = Path.home() / 'Library/Application Support/VivicModelAPI'
sys.path.insert(0, str(LAB))
import run_eval as evaluation

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--dataset-sha256', required=True)
    parser.add_argument('--limit', type=int)
    args = parser.parse_args()
    dataset_hash = hashlib.sha256(canonical(evaluation.DATA)).hexdigest()
    if dataset_hash != args.dataset_sha256:
        raise RuntimeError('Frozen dataset differs from the current repository')
    headers = {'Authorization': 'Bearer ' + (ROOT / 'worker-token').read_text().strip(),
               'Content-Type': 'application/json', 'X-Vivic-Owner': 'g-demo-acceptance'}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def health():
        with opener.open('http://127.0.0.1:19095/health', timeout=10) as response:
            return json.load(response)
    def ask(text, questions):
        started = time.perf_counter()
        for attempt in range(5):
            request = urllib.request.Request('http://127.0.0.1:19095/v1/native',
                json.dumps({'state': evaluation.kev_state(text), 'questions': questions}, ensure_ascii=False).encode(), headers)
            try:
                with opener.open(request, timeout=30) as response:
                    value = json.load(response)
                return value['answers'], round((time.perf_counter() - started) * 1000, 1), attempt
            except urllib.error.HTTPError as error:
                if error.code != 429 or attempt == 4:
                    raise RuntimeError('Resident evaluation HTTP ' + str(error.code)) from None
                time.sleep(.5 * (attempt + 1))
        raise RuntimeError('Resident service remained busy')
    initial = health()
    if not initial.get('loaded') or initial.get('model') != 'startlux-decision-4b':
        raise RuntimeError('Expected resident 4B is not loaded')
    selected = evaluation.CASES[:args.limit] if args.limit else evaluation.CASES
    route_question = {'type': 'choice', 'instructions': evaluation.ROUTE_INSTR, 'criteria': evaluation.ROUTES}
    started = time.perf_counter()
    ask('Warmup', {'route': route_question})
    warm_s = round(time.perf_counter() - started, 3)
    report = {'model': 'startlux-4b-q8-metal-resident-g-20261030',
              'at': datetime.now(timezone.utc).isoformat(), 'dataset_sha256': dataset_hash,
              'load_s': 0, 'warmup_s': warm_s, 'scope': 'Frozen synthetic benchmark, resident service; no user actions or model lifecycle changes.',
              'initial_health': initial, 'rows': [], 'complete': False}
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        backup = output.with_name(output.name + '.bak-' + datetime.now().strftime('%Y%m%dT%H%M%S'))
        backup.write_bytes(output.read_bytes())
    def save():
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    try:
        for index, case in enumerate(selected):
            route_answers, route_ms, retries = ask(case['text'], {'route': route_question})
            questions = {'route': route_question, 'multi': {'type': 'noul', 'instructions': evaluation.MULTI_INSTR}}
            if case.get('target'):
                questions['target'] = {'type': 'choice', 'instructions': evaluation.TARGET_INSTR, 'criteria': evaluation.TARGETS}
            full, full_ms, full_retries = ask(case['text'], questions)
            route = route_answers['route'].get('choice')
            probabilities = route_answers['route'].get('probabilities') or {}
            multi = full['multi']
            multi_p = multi.get('probability', multi.get('noul', 1.0 if multi.get('answer') else 0.0))
            report['rows'].append({'case': case, 'route': route, 'route_p': probabilities.get(route),
                'route_ok': route == case['route'], 'route_ms': route_ms, 'full_ms': full_ms,
                'target': full.get('target', {}).get('choice'), 'multi_p': float(multi_p or 0),
                'queue_retries': retries + full_retries})
            if (index + 1) % 10 == 0 or index + 1 == len(selected):
                save()
                print(json.dumps({'completed': index + 1, 'total': len(selected),
                                  'correct': sum(row['route_ok'] for row in report['rows'])}), flush=True)
        report['summary'] = evaluation.summarize(report['rows'])
        report['high_confidence_false_delete'] = sum(row['route'] == 'delete' and row['case']['route'] != 'delete'
            and (row['route_p'] or 0) >= .8 for row in report['rows'])
        report['final_health'] = health()
        report['same_engine'] = initial['engine_pid'] == report['final_health']['engine_pid'] and initial['generation'] == report['final_health']['generation']
        report['complete'] = len(report['rows']) == len(selected)
        print(json.dumps({'complete': report['complete'], 'same_engine': report['same_engine'],
                          'summary': report['summary']}, ensure_ascii=True), flush=True)
    finally:
        save()

if __name__ == '__main__':
    main()
