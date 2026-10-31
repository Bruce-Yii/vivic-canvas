#!/usr/bin/env bash
set -euo pipefail

# Run from a source bundle/root on an existing Linux Docker host. No daemon,
# firewall, public listener, DNS, certificate store or existing proxy is changed.
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
test "$(uname -s)" = Linux || { echo 'An actual Linux host is required.' >&2; exit 1; }
for tool in docker openssl ss; do command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }; done
docker compose version >/dev/null
test -f scripts/online-probe.mjs
test -f deploy/online/verify/fixture.mjs
available_kib="$(df -Pk "$root" | awk 'NR==2 {print $4}')"
test "$available_kib" -ge 4194304 || { echo 'At least 4 GiB free disk is required; nothing changed.' >&2; exit 1; }
available_mem_kib="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
test "$available_mem_kib" -ge 524288 || { echo 'At least 512 MiB available RAM is required; nothing changed.' >&2; exit 1; }
if ss -H -ltn '( sport = :18443 or sport = :18444 )' | read -r _; then echo 'Verification ports 18443/18444 already in use; nothing changed.' >&2; exit 1; fi
project="vivic-online-check-$(date -u +%Y%m%d%H%M%S)-$$"
if test -n "${VIVIC_CHECK_EXISTING_IMAGE:-}"; then
  [[ "$VIVIC_CHECK_EXISTING_IMAGE" =~ ^vivic-online-check-[a-z0-9-]+:local$ ]] || { echo 'Only an explicitly named prior verification image may be reused.' >&2; exit 1; }
  test "$(docker image inspect "$VIVIC_CHECK_EXISTING_IMAGE" --format '{{.Os}}')" = linux
  export VIVIC_CHECK_IMAGE="$VIVIC_CHECK_EXISTING_IMAGE"
else
  export VIVIC_CHECK_IMAGE="$project:local"
fi
umask 077
export VIVIC_ONLINE_CHECK_DIR="$root/.verification/$project"
mkdir -p "$root/.verification"
mkdir "$VIVIC_ONLINE_CHECK_DIR"
mkdir "$VIVIC_ONLINE_CHECK_DIR/cert"
sha256sum apps/local-api/src/online/index.ts apps/local-api/src/online/sessions.ts apps/local-api/src/online/mobileBridge.ts apps/local-api/src/online/appFactory.ts apps/local-api/package.json pnpm-lock.yaml apps/web/dist-online/index.html deploy/online/Dockerfile > "$VIVIC_ONLINE_CHECK_DIR/source-sha256s.txt"
compose=(docker compose --project-name "$project" --file deploy/online/compose.verify.yaml)
cleanup() {
  "${compose[@]}" logs --no-color --tail 50 tls > "$VIVIC_ONLINE_CHECK_DIR/tls.log" 2>&1 || true
  "${compose[@]}" down --timeout 10 >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 2 -keyout "$VIVIC_ONLINE_CHECK_DIR/cert/server.key" -out "$VIVIC_ONLINE_CHECK_DIR/cert/server.crt" -subj '/CN=vivic-staging.localhost' -addext 'subjectAltName=DNS:vivic-staging.localhost' >/dev/null 2>&1
# Nginx master is root in this isolated container; key remains 0600 on host.
"${compose[@]}" config --quiet
if test -z "${VIVIC_CHECK_EXISTING_IMAGE:-}"; then "${compose[@]}" build --pull vivic; fi
docker run --rm --network none --read-only --security-opt no-new-privileges --cap-drop ALL "$VIVIC_CHECK_IMAGE" node -e "if(process.platform!=='linux'||process.getuid()===0)process.exit(1);require('sharp')({create:{width:1,height:1,channels:3,background:'#fff'}}).png().toBuffer().then(b=>{if(b.length===0)process.exit(1);console.log(JSON.stringify({platform:process.platform,arch:process.arch,uid:process.getuid(),sharpOutputBytes:b.length}))}).catch(()=>process.exit(1))" > "$VIVIC_ONLINE_CHECK_DIR/native.json"
"${compose[@]}" up -d --wait --wait-timeout 180
"${compose[@]}" ps --format json > "$VIVIC_ONLINE_CHECK_DIR/containers.json"
# This deliberately prints only safe selected metadata, never docker inspect Env.
docker image inspect "$VIVIC_CHECK_IMAGE" --format '{{.Os}}/{{.Architecture}} user={{.Config.User}}' > "$VIVIC_ONLINE_CHECK_DIR/image.txt"
printf 'prebuiltWeb=true\nimageReused=%s\n' "${VIVIC_CHECK_EXISTING_IMAGE:-false}" > "$VIVIC_ONLINE_CHECK_DIR/build-mode.txt"
ss -H -ltn '( sport = :18443 or sport = :18444 )' > "$VIVIC_ONLINE_CHECK_DIR/listeners.txt"
node_image="${VIVIC_CHECK_NODE_IMAGE:-node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20}"
probe=(docker run --rm --network host --read-only --security-opt no-new-privileges --cap-drop ALL --user "$(id -u):$(id -g)" --volume "$root/scripts:/checks:ro" --volume "$VIVIC_ONLINE_CHECK_DIR:/evidence" "$node_image" node /checks/online-probe.mjs)
"${probe[@]}" --origin=https://vivic-staging.localhost:18443 --connect-host=127.0.0.1 --ca=/evidence/cert/server.crt --report=/evidence/production.json
"${probe[@]}" --origin=https://vivic-staging.localhost:18444 --connect-host=127.0.0.1 --ca=/evidence/cert/server.crt --fixture --report=/evidence/fixture.json
docker run --rm --network host --read-only --security-opt no-new-privileges --cap-drop ALL --user "$(id -u):$(id -g)" --volume "$root/scripts:/checks:ro" --volume "$VIVIC_ONLINE_CHECK_DIR:/evidence" "$node_image" node /checks/online-mobile-probe.mjs --origin=https://vivic-staging.localhost:18443 --connect-host=127.0.0.1 --ca=/evidence/cert/server.crt --report=/evidence/mobile.json
echo "Linux image and isolated TLS reverse proxy checks passed. Evidence: $VIVIC_ONLINE_CHECK_DIR"
echo 'No production route, daemon, certificate store, firewall or public port changed; verification containers are now stopped.'
