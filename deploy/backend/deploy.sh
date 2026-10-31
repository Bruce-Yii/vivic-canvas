#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
DIR=/opt/vivic-preview-20261025/backend
DATA=/var/lib/vivic-preview-20261025
STAGING=/var/lib/vivic-staging
CURRENT=vivic-preview-20261027
PREVIOUS=vivic-api-prev
STAGE=vivic-api-staging
sha=${1:?Usage: deploy.sh git-sha}
[[ $sha =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected full Git SHA' >&2; exit 1; }
exec 9>"$DIR/deploy.lock"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }
available=$(df -B1 --output=avail / | tail -n1 | tr -d ' ')
(( available >= 2147483648 )) || { echo 'Less than 2 GiB available' >&2; exit 1; }
[[ $(realpath "$DATA") == "$DATA" && -f "$DATA/space.sqlite" ]]
if [[ ! -f "$DIR/env.list" ]]; then
  echo "Install the private environment file at $DIR/env.list with mode 600 before deploying" >&2
  exit 1
fi
chmod 600 "$DIR/env.list"
if docker inspect "$STAGE" >/dev/null 2>&1; then
  [[ $(docker inspect --format '{{index .Config.Labels "vivic.managed"}}' "$STAGE") == backend ]]
  docker rm -f "$STAGE" >/dev/null
fi
[[ ! -L "$STAGING" ]] || { echo 'Unexpected staging symlink' >&2; exit 1; }
[[ ! -e "$STAGING" ]] || { echo 'Inspect existing staging data first' >&2; exit 1; }
bundle="$DIR/bundles/$sha"
mkdir -p "$bundle"
tar -xf "$DIR/uploads/$sha.tar" -C "$bundle" --no-same-owner
base=$(docker inspect --format '{{.Config.Image}}' "$CURRENT")
[[ $(docker image inspect --format '{{.Id}}' "$base") == $(docker inspect --format '{{.Image}}' "$CURRENT") ]]
image="vivic-api:$sha"
docker build --build-arg "BASE=$base" --build-arg "REVISION=$sha" \
  -f "$DIR/Dockerfile" -t "$image" "$bundle"

stage_created=0
old_stopped=0
success=0
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 && old_stopped == 1 && success == 0 )); then
    if docker inspect "$PREVIOUS" >/dev/null 2>&1; then
      VIVIC_DEPLOY_LOCK_HELD=1 bash "$DIR/rollback.sh" || status=1
    else
      docker start "$CURRENT" >/dev/null || status=1
    fi
  fi
  if (( stage_created == 1 )); then
    if (( status != 0 )); then
      log="$DIR/staging-failure-$(date +%Y%m%dT%H%M%S).log"
      docker logs "$STAGE" >"$log" 2>&1 || true
      chmod 600 "$log"
      printf 'STAGING_FAILURE_LOG=%s\n' "$log" >&2
    fi
    docker rm -f "$STAGE" >/dev/null 2>&1 || true
    if [[ "$STAGING" == /var/lib/vivic-staging && ! -L "$STAGING" ]]; then
      rm -rf -- "$STAGING"
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
stage_created=1
cp -a "$DATA" "$STAGING"
# A process lock belongs to the production instance, never to its staged copy.
rm -f "$STAGING/space.lock"
# Use the application runtime, since CentOS SQLite cannot read STRICT tables.
docker run --rm --user node -v "$DATA:/data/vivic:ro" -v "$STAGING:/staging" \
  --entrypoint node "$image" --no-warnings --input-type=module -e \
  "import { DatabaseSync, backup } from 'node:sqlite'; const db=new DatabaseSync('/data/vivic/space.sqlite',{readOnly:true}); await backup(db,'/staging/space.consistent.sqlite'); db.close(); console.log('consistent-backup-ok');"
rm -f "$STAGING/space.sqlite" "$STAGING/space.sqlite-wal" "$STAGING/space.sqlite-shm"
mv "$STAGING/space.consistent.sqlite" "$STAGING/space.sqlite"
chown --reference="$DATA/space.sqlite" "$STAGING/space.sqlite"

health() {
  local port=$1
  for ((i=0; i<30; i++)); do
    if curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >"$DIR/healthz.json" 2>/dev/null; then
      if python3 -c 'import json,sys; assert json.load(open(sys.argv[1])).get("ok") is True' "$DIR/healthz.json"; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

docker run -d --name "$STAGE" --label vivic.managed=backend \
  --label "vivic.git.sha=$sha" --user node --restart no \
  --workdir /app/apps/local-api \
  -p 127.0.0.1:18891:8790 -v "$STAGING:/data/vivic" \
  --env-file "$DIR/env.list" "$image" node --import tsx src/online/index.ts >/dev/null
health 18891
docker exec "$STAGE" node --import tsx --input-type=module -e \
  "await import('./src/intent/pipeline.ts'); await import('./src/space/executor.ts'); await import('@vivic/contracts'); await import('@vivic/card-runtime'); console.log('dependency-imports-ok'); process.exit(0);"
docker exec "$STAGE" node --no-warnings --input-type=module -e \
  "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync('/data/vivic/space.sqlite',{readOnly:true}); if(db.prepare('PRAGMA quick_check').all().some(x=>Object.values(x)[0]!=='ok')) throw Error('SQLite integrity check failed'); db.close(); console.log('staging-sqlite-ok');"

if docker inspect "$PREVIOUS" >/dev/null 2>&1; then
  docker rm "$PREVIOUS" >/dev/null
fi
docker stop --time 15 "$CURRENT" >/dev/null
old_stopped=1
backup="/opt/vivic-preview-20261025/backups/db-$(date +%Y%m%dT%H%M%S)-$$"
mkdir -p "$backup"
cp -a "$DATA"/space.sqlite* "$backup/"
docker rename "$CURRENT" "$PREVIOUS"
docker run -d --name "$CURRENT" --label vivic.managed=backend \
  --label "vivic.git.sha=$sha" --user node --restart unless-stopped \
  --workdir /app/apps/local-api \
  -p 127.0.0.1:18890:8790 -v "$DATA:/data/vivic" \
  --env-file "$DIR/env.list" "$image" node --import tsx src/online/index.ts >/dev/null
health 18890
curl --noproxy '*' -k -fsS --max-time 10 --resolve vivic.edsionc.top:443:127.0.0.1 \
  https://vivic.edsionc.top/ >/dev/null
docker exec "$CURRENT" node --no-warnings --input-type=module -e \
  "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync('/data/vivic/space.sqlite',{readOnly:true}); if(db.prepare('PRAGMA quick_check').all().some(x=>Object.values(x)[0]!=='ok')) throw Error('SQLite integrity check failed'); db.close(); console.log('production-sqlite-ok');"
printf 'sha=%s\nimage=%s\ntime=%s\nbackup=%s\naction=deploy\n' \
  "$sha" "$image" "$(date -Is)" "$backup" >"$DIR/DEPLOYED.tmp"
mv "$DIR/DEPLOYED.tmp" "$DIR/DEPLOYED"
success=1
mapfile -t tags < <(docker image ls vivic-api --format '{{.Repository}}:{{.Tag}}')
if (( ${#tags[@]} > 3 )); then
  for old in "${tags[@]:3}"; do
    docker image rm "$old" >/dev/null 2>&1 || true
  done
fi
printf 'DEPLOY_OK sha=%s image=%s\n' "$sha" "$image"
