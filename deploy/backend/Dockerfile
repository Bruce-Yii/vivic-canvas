ARG BASE
FROM ${BASE}
ARG REVISION
LABEL org.opencontainers.image.revision=${REVISION}
COPY --chown=node:node apps/local-api/src/ /app/apps/local-api/src/
COPY --chown=node:node packages/contracts/src/ /app/apps/local-api/node_modules/@vivic/contracts/src/
COPY --chown=node:node packages/card-runtime/src/ /app/apps/local-api/node_modules/@vivic/card-runtime/src/
