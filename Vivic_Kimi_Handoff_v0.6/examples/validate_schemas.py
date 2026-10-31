"""Validate sample Vivic wire messages and reject unwanted countdown text.
Run: python examples/validate_schemas.py (requires jsonschema, referencing).
This is a documentation contract check, not production code.
"""
from pathlib import Path
import json
from copy import deepcopy
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

root=Path(__file__).resolve().parents[1]
action=json.loads((root/'contracts/action-envelope.schema.json').read_text())
card=json.loads((root/'contracts/card-record.schema.json').read_text())
registry=Registry().with_resource(card['$id'],Resource.from_contents(card))
validator=Draft202012Validator(action,registry=registry)
Draft202012Validator.check_schema(action)
Draft202012Validator.check_schema(card)
for filename in ['01_focus_and_countdown.json','02_search_results.json']:
    example=json.loads((root/'examples'/filename).read_text())
    validator.validate(example)
    print('PASS', filename)
invalid=json.loads((root/'examples/01_focus_and_countdown.json').read_text())
invalid['actions'][0]['card']['displayProps']['description']='继续加油！'
errors=list(validator.iter_errors(invalid))
assert errors, 'Countdown minimal forbidden description must be rejected'
print('PASS negative case: countdown forbids description')
