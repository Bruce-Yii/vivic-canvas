#!/usr/bin/env python3
"""Bounded sequential runner: no services, no concurrent model residency."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, default=ROOT / '.cache/laya-poc')
    parser.add_argument('--device', choices=['cpu', 'mps', 'both'], default='both')
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--timeout', type=int, default=240, help='Per device wall time in seconds')
    args = parser.parse_args()
    if args.timeout < 1 or args.repeats < 1:
        parser.error('timeout and repeats must be positive')
    cache = args.cache_dir.resolve()
    devices = ['cpu', 'mps'] if args.device == 'both' else [args.device]
    for device in devices:
        directory = ROOT / 'evidence/phase2-decision' / device
        directory.mkdir(parents=True, exist_ok=True)
        command = [str(cache / 'venv/bin/python'), str(HERE / 'benchmark.py'), '--cache-dir',
                   str(cache), '--device', device, '--repeats', str(args.repeats)]
        try:
            with (directory / 'console.txt').open('w') as stream:
                print('Running', device, 'timeout', args.timeout, 'seconds', flush=True)
                completed = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT,
                                           timeout=args.timeout)
            if completed.returncode:
                dest = directory / 'summary.json'
                result = json.loads(dest.read_text()) if dest.exists() else {}
                result.update(status='BLOCKED', returncode=completed.returncode,
                              reason=result.get('reason', 'Benchmark process failed; see console.txt'))
                dest.write_text(json.dumps(result, indent=2) + '\n')
                return 2
        except (subprocess.TimeoutExpired, OSError) as exc:
            dest = directory / 'summary.json'
            result = {'status': 'BLOCKED', 'reason': type(exc).__name__ + ': ' + str(exc),
                      'device_requested': device, 'command': command, 'timeout_seconds': args.timeout}
            dest.write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps(result, indent=2))
            return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
