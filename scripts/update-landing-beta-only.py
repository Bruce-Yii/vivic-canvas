#!/usr/bin/env python3
"""Keep the existing hosted landing page in application-only mode.

Usage: python3 scripts/update-landing-beta-only.py INPUT.html OUTPUT.html
Updates the deployed single-file build without replacing its registration API
or its four QR cards. Each replacement is guarded and safe to repeat.
"""
import re
import sys
from pathlib import Path


def replace_once(html, old, new):
    count = html.count(old)
    if count == 0 and new in html:
        return html
    if count != 1:
        raise ValueError('Expected one landing fragment: ' + old[:100])
    return html.replace(old, new, 1)


def update(html):
    replacements = [
        (
            'return(0,D.jsx)(`button`,{type:`button`,className:e,onClick:m2e,children:n})',
            'return(0,D.jsx)(`button`,{type:`button`,className:e+` is-disabled`,disabled:!0,"aria-disabled":!0,title:`内测暂未开放，请先申请内测`,children:n})',
        ),
        (
            't(`success`),r.current=window.setTimeout(()=>window.location.assign(`/vivic/app/`),700)',
            't(`success`)',
        ),
        (
            'o=e===`success`,s=e===`submitting`||o;',
            'o=e===`success`,s=e===`submitting`||o||e===`pending`;',
        ),
        (
            'id:`beta`,className:`lp-beta`,onSubmit:a,"aria-busy":s||void 0',
            'id:`beta`,className:`lp-beta`,onSubmit:a,"aria-busy":e===`submitting`||void 0',
        ),
        ('children:o?`申请获准`', 'children:o?`已申请`'),
        (
            'children:o?`申请已获准，正在进入 VIVIC…`:e===`pending`?`已申请，申请记录已保存，请等待内测开放通知。`',
            'children:o?`申请提交成功！内测开放时，我们会通过邮件通知你。`:e===`pending`?`申请提交成功！内测开放时，我们会通过邮件通知你。`',
        ),
        ('提交邮箱申请内测，获准后可进入 VIVIC。', '提交邮箱申请内测，开放后将通过邮件通知。'),
        ('申请获准后，即可开始', '内测暂未开放，请先申请'),
        ('提交邮箱申请内测，获准后即可进入你的画布。', '目前仅开放内测申请，开放后将通过邮件通知。'),
        (
            '<noscript>VIVIC 内测落地页需要启用 JavaScript。<a href="/">进入 VIVIC</a></noscript>',
            '<noscript>VIVIC 内测申请页需要启用 JavaScript。</noscript>',
        ),
    ]
    for old, new in replacements:
        html = replace_once(html, old, new)
    if 'window.location.assign(`/vivic/app/`)' in html:
        raise ValueError('Application redirect is still present')
    html = re.sub(r'<style id="vivic-beta-only">[\s\S]*?</style>\r?\n?', '', html)
    style = '''<style id="vivic-beta-only">
.lp .is-disabled,.lp .is-disabled:hover{color:#9699a3!important;background:#e5e6eb!important;border-color:#d9dbe2!important;box-shadow:none!important;cursor:not-allowed!important;transform:none!important;opacity:1}
.lp .lp-header-link.is-disabled{border-radius:999px;padding:9px 14px}
</style>'''
    if html.count('</head>') != 1:
        raise ValueError('Expected one document head')
    return html.replace('</head>', style + '\n</head>')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    source, target = map(Path, sys.argv[1:])
    target.write_bytes(update(source.read_bytes().decode('utf-8')).encode('utf-8'))
    print('Updated landing page: application stays in place; entry buttons disabled')
