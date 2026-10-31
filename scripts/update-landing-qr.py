#!/usr/bin/env python3
"""Update the contact cards in Vivic's existing single-file landing build.

Usage: python3 scripts/update-landing-qr.py INPUT.html OUTPUT.html QR_CONFIG.json
Reads the current hosted build so beta registration and application routes stay
in place. The config contains four records with local image paths and links.
"""
import base64
import json
import re
import sys
from pathlib import Path


def update(source, records):
    if len(records) != 4 or len({record['id'] for record in records}) != 4:
        raise ValueError('Expected four distinct QR cards')
    for record in records:
        if not record['src'].startswith('data:image/png;base64,'):
            raise ValueError('QR images must be embedded PNG files')
        if not record['href'].startswith('https://'):
            raise ValueError('QR links must use HTTPS')

    # This is the existing contact data, followed by the next compiled function.
    pattern = r'\[\{(?:id:`xiaohongshu`|"id":"xiaohongshu")[\s\S]*?\}\](?=;function)'
    matches = list(re.finditer(pattern, source))
    if len(matches) != 1:
        raise ValueError('Could not uniquely locate the existing contact list')
    source = source[:matches[0].start()] + json.dumps(records, ensure_ascii=False, separators=(',', ':')) + source[matches[0].end():]

    # Keep the existing React component and make its QR images clickable.
    image_pattern = r'children:\(0,([A-Za-z_$][\w$]*)\.jsx\)\(`img`,\{src:([A-Za-z_$][\w$]*)\.src,alt:`\$\{\2\.platform\}「\$\{\2\.group\}」二维码`,width:200,height:200,loading:`lazy`,decoding:`async`\}\)'
    image_matches = list(re.finditer(image_pattern, source))
    if len(image_matches) == 1:
        match = image_matches[0]
        jsx, item = match.group(1), match.group(2)
        image = match.group(0).removeprefix('children:').replace('loading:`lazy`', 'loading:`eager`')
        replacement = f'children:(0,{jsx}.jsx)(`a`,{{href:{item}.href,target:`_blank`,rel:`noopener noreferrer`,"aria-label":{item}.linkLabel,children:{image}}})'
        source = source[:match.start()] + replacement + source[match.end():]
    elif '"aria-label":e.linkLabel' not in source:
        raise ValueError('Could not locate the existing contact image component')

    original = '想聊聊 Vivic、提一点建议，或者第一时间看到新卡片？扫码加入内测交流群。'
    updated = '扫码访问官网、加入交流群，或查看麦当劳 MCP 卡片项目。你也可以把自己的服务接入 Vivic。'
    source = source.replace(original, updated)

    source = re.sub(r'<style id="vivic-contact-qr-layout">[\s\S]*?</style>\r?\n?', '', source)
    style = '''<style id="vivic-contact-qr-layout">
.lp-contact-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));max-width:1320px;margin-left:auto;margin-right:auto;gap:24px;align-items:stretch}
.lp-contact-grid>div{min-width:0;height:100%;opacity:1!important;transform:none!important}
.lp-contact-card{box-sizing:border-box;width:100%;height:100%;padding-left:20px;padding-right:20px}
.lp-contact-qr a{display:block;line-height:0;border-radius:16px}
.lp-contact-qr a:focus-visible{outline:3px solid var(--lp-brand);outline-offset:6px}
.lp-contact-qr img{display:block;width:200px;height:200px;max-width:100%;object-fit:contain}
.lp-contact-hint{line-height:1.7;max-width:100%;text-align:center}
@media(max-width:1100px){.lp-contact-grid{grid-template-columns:repeat(2,minmax(0,1fr));max-width:740px}}
@media(max-width:640px){.lp-contact-grid{grid-template-columns:minmax(0,1fr);max-width:360px}}
</style>'''
    if source.count('</head>') != 1:
        raise ValueError('Expected one document head')
    return source.replace('</head>', style + '\n</head>')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    input_path, output_path, config_path = map(Path, sys.argv[1:])
    config = json.loads(config_path.read_text())
    records = []
    for item in config:
        record = dict(item)
        image_path = Path(record.pop('image'))
        if not image_path.is_absolute():
            image_path = config_path.parent / image_path
        image = image_path.read_bytes()
        if not image.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('Expected PNG: ' + str(image_path))
        record['src'] = 'data:image/png;base64,' + base64.b64encode(image).decode()
        records.append(record)
    html = input_path.read_bytes().decode('utf-8')
    output_path.write_bytes(update(html, records).encode('utf-8'))
    print('Updated four embedded, clickable QR cards:', output_path)
