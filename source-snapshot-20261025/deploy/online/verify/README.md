# Isolated Linux / HTTPS verification

This is an opt-in verification environment. It does not configure a public
website, change host nginx, install a daemon, trust a certificate globally, open
a firewall, or use a live model credential. The application UI is the existing
online Hark build.

Run from a fresh source bundle on a Linux machine with Docker Engine + Compose,
OpenSSL, `ss`, at least 4 GiB free disk and 512 MiB available memory:

```sh
bash scripts/online-linux-verify.sh
```

It installs Linux-native dependencies with the frozen lockfile, reuses the
bundle's explicitly marked online web build, builds a non-root runtime image,
and starts a unique `vivic-online-check-*` Compose project. The only host
listeners are `127.0.0.1:18443` and `127.0.0.1:18444`. No host daemon sockets or
production configuration are mounted into containers.

Two fresh backend processes share the built image:

- Port 18443 proxies to the real production online entry point. Checks create
  isolated cookies and synthetic mobile peers, exercise the built-in intent
  stream, and wait for a real 20-second mobile long poll.
- Port 18444 proxies to the real cookie boundary and real app factory, with a
  deterministic model HTTP stub. This verifies credential isolation and cleanup
  without network calls or real model keys. The clock is advanced for the idle
  expiration check; it does not wait 30 minutes. A deliberately delayed test
  model response also checks that the SSE accepted event reaches the client
  before the final result, rather than merely checking its final Content-Type.

TLS uses a two-day self-signed certificate for `vivic-staging.localhost`. The
probe explicitly trusts that one certificate and still verifies the hostname
and certificate chain. It never uses `-k`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, or
system-wide trust changes. This is **private TLS staging**, not a publicly
trusted production deployment.

For a host that cannot access Docker Hub directly, the same pinned official
manifests are available through the AWS mirror used in the target-host check:

```sh
export VIVIC_CHECK_NODE_IMAGE=public.ecr.aws/docker/library/node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
export VIVIC_CHECK_NGINX_IMAGE=public.ecr.aws/docker/library/nginx:stable-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951
bash scripts/online-linux-verify.sh
```

The digests remain unchanged. No Docker daemon mirror or DNS setting is changed.
Docker's verified official-image publishing on ECR is described in the
[AWS announcement](https://aws.amazon.com/blogs/containers/docker-official-images-now-available-on-amazon-elastic-container-registry-public/).
To repeat probes against an **unchanged, previously built** verification image,
set `VIVIC_CHECK_EXISTING_IMAGE=vivic-online-check-<its exact name>:local`. This
skips the build, records reuse in `build-mode.txt`, and creates a fresh Compose
project. Never use it to claim that changed application source was rebuilt.

Evidence stays in `.verification/<project>/`. JSON reports contain check names,
durations and success flags, without cookies, tokens, keys, frames or user data.
The certificate private key is test-only, mode 0600 and excluded from Docker
context. Do not distribute the `cert` directory. Test containers and their
network are stopped automatically on exit; the image, source and evidence stay
available. No global prune, existing image removal or source deletion occurs.

Production deploys continue using `compose.yaml`. Its port can be changed with
`VIVIC_ONLINE_PORT`, but always binds host loopback. `nginx-location.conf` is a
reviewable template for a future dedicated HTTPS origin; it is not installed by
the check. Mobile uses HTTPS JSON long polling, not WebSocket, so no Upgrade
header is required. The read timeout of 150 seconds also preserves intent SSE.

Sources: [Docker ignore-file precedence](https://docs.docker.com/build/concepts/context/#dockerignore-files),
[Compose service networking](https://docs.docker.com/compose/how-tos/networking/),
[nginx proxy buffering and timeouts](https://nginx.org/en/docs/http/ngx_http_proxy_module.html),
[official Node images in ECR](https://gallery.ecr.aws/docker/library/node).
