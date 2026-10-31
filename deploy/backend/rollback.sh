#!/usr/bin/env bash
set -Eeuo pipefail
DIR=/opt/vivic-preview-20261025/backend
CURRENT=vivic-preview-20261027
PREVIOUS=vivic-api-prev
if [[ ${VIVIC_DEPLOY_LOCK_HELD:-0} != 1 ]]; then
  exec 9>"$DIR/deploy.lock"
  flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
fi
docker inspect "$PREVIOUS" >/dev/null
failed="vivic-api-failed-$(date +%Y%m%dT%H%M%S)-$$"
if docker inspect "$CURRENT" >/dev/null 2>&1; then
  docker stop --time 15 "$CURRENT" >/dev/null
  docker rename "$CURRENT" "$failed"
fi
docker rename "$PREVIOUS" "$CURRENT"
docker start "$CURRENT" >/dev/null
ok=0
for ((i=0; i<30; i++)); do
  if curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:18890/healthz >"$DIR/healthz.json" 2>/dev/null; then
    if python3 -c 'import json,sys; assert json.load(open(sys.argv[1])).get("ok") is True' "$DIR/healthz.json"; then
      ok=1
      break
    fi
  fi
  sleep 1
done
[[ $ok == 1 ]] || { echo 'Rollback health check failed' >&2; exit 1; }
image=$(docker inspect --format '{{.Config.Image}}' "$CURRENT")
sha=$(docker inspect --format '{{index .Config.Labels "vivic.git.sha"}}' "$CURRENT")
if [[ -z "$sha" || "$sha" == '<no value>' ]]; then sha=unversioned-original-baseline; fi
printf 'sha=%s\nimage=%s\ntime=%s\naction=rollback\n' "$sha" "$image" "$(date -Is)" >"$DIR/DEPLOYED.tmp"
mv "$DIR/DEPLOYED.tmp" "$DIR/DEPLOYED"
printf 'ROLLBACK_OK image=%s\n' "$image"
