ARG VIVIC_NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
FROM ${VIVIC_NODE_IMAGE} AS build
WORKDIR /build
ARG VIVIC_ONLINE_PREBUILT_WEB=0
ARG NODE_OPTIONS=--max-old-space-size=512
ENV NODE_OPTIONS=$NODE_OPTIONS
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/local-api/package.json apps/local-api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/card-runtime/package.json packages/card-runtime/package.json
COPY contrib/mobile-console/package.json contrib/mobile-console/package.json
RUN if [ "$VIVIC_ONLINE_PREBUILT_WEB" = "1" ]; then pnpm install --frozen-lockfile --filter @vivic/local-api...; else pnpm install --frozen-lockfile; fi
COPY . .
RUN if [ "$VIVIC_ONLINE_PREBUILT_WEB" = "1" ]; then node -e "const fs=require('fs');if(JSON.parse(fs.readFileSync('apps/web/dist-online/.vivic-online-build.json')).mode!=='online'||!fs.existsSync('apps/web/dist-online/index.html'))process.exit(1)"; else pnpm --filter @vivic/web build:online; fi
# A metadata-only download directory produces a live 404. Check the actual bytes
# after Docker's context filters and Vite have both run, before publishing them.
RUN node --input-type=module <<'NODE'
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const directory = 'apps/web/dist-online/downloads';
const metadataPath = `${directory}/android.json`, apkPath = `${directory}/Vivic-Remote.apk`;
const metadataExists = fs.existsSync(metadataPath), apkExists = fs.existsSync(apkPath);
if (metadataExists !== apkExists) throw new Error('Android download must contain both android.json and Vivic-Remote.apk.');
if (metadataExists) {
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')), apk = fs.readFileSync(apkPath);
  if (metadata.file !== 'Vivic-Remote.apk' || metadata.bytes !== apk.length ||
      metadata.sha256 !== createHash('sha256').update(apk).digest('hex')) {
    throw new Error('Android download bytes or SHA256 do not match android.json.');
  }
}
NODE
RUN pnpm --filter @vivic/local-api deploy --prod --config.node-linker=hoisted /out/apps/local-api
RUN mkdir -p /out/apps/web && cp -a apps/web/dist-online /out/apps/web/dist-online

FROM ${VIVIC_NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8790 VIVIC_ONLINE_BIND_HOST=0.0.0.0
ARG VIVIC_CONNECTOR_CLIS=0
COPY deploy/online/connector-clis.json deploy/online/install-connector-clis.mjs deploy/online/CONNECTOR-LICENSES.txt /opt/vivic/installer/
RUN if [ "$VIVIC_CONNECTOR_CLIS" = "1" ]; then apt-get update && apt-get install -y --no-install-recommends ca-certificates tar && node /opt/vivic/installer/install-connector-clis.mjs && rm -rf /var/lib/apt/lists/*; fi
ENV VIVIC_LARK_CLI_PATH=/opt/vivic/connectors/lark/1.0.97/lark-cli \
    VIVIC_WECOM_CLI_PATH=/opt/vivic/connectors/wecom/1.3.4/wecom-cli
COPY --from=build --chown=node:node /out /app
WORKDIR /app/apps/local-api
RUN mkdir -p /data/vivic && chown node:node /data/vivic
ENV VIVIC_SPACE_DATA_DIR=/data/vivic
USER node
EXPOSE 8790
CMD ["node", "--import", "tsx", "src/online/index.ts"]
