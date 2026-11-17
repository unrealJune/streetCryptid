# streetcrypt.id: Caddy with the site baked in. Build from the repository root:
#
#   docker build -f website/Dockerfile website
#
# The context is `website/`, not the repository root, so the root .dockerignore (the server
# image's allowlist) does not apply and nothing outside this directory can reach the image.
#
# Pinned by digest because nothing updates it for us: Flux's caddy ImagePolicy used to bump the
# tag in Buttercup, and the image is now ours. Bump both together.
FROM docker.io/library/caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b

# Caddy writes to its XDG dirs even with the admin API off. Owned by the uid the chart runs as, so
# `docker run` works without volumes; Kubernetes mounts emptyDirs over both anyway.
RUN mkdir -p /data /config && chown 1000:1000 /data /config

COPY Caddyfile /etc/caddy/Caddyfile
COPY site/ /srv/

# A typo in the Caddyfile fails the build, not the rollout.
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

USER 1000:1000
EXPOSE 8080
