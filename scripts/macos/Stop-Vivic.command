#!/bin/bash
set -euo pipefail
taskRoot="$(cd -- "$(dirname "$0")" && pwd -P)"
cd -- "$taskRoot"
/usr/bin/shasum -a 256 -c runtime/node.sha256 >/dev/null
exec "$taskRoot/runtime/node" "$taskRoot/Vivic-Launcher.mjs" stop "$@"
