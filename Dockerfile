# ddguard has no runtime dependencies, so there is nothing to install and nothing to
# build — the image is the source tree on top of a Node runtime, and that is all.
FROM node:22-alpine

LABEL org.opencontainers.image.title="ddguard" \
      org.opencontainers.image.description="Catches Datadog monitors that will never fire, before they merge." \
      org.opencontainers.image.source="https://github.com/krishras23/ddguard"

WORKDIR /app

COPY package.json ./
COPY ddguard/ ./ddguard/
COPY mockdd/ ./mockdd/
COPY fixtures/ ./fixtures/
COPY docker-entrypoint.sh /usr/local/bin/ddguard-entrypoint

# mockdd seeds its fixture at run time, not build time: the generated series are anchored
# to the current clock, so data baked at build time would be 30 days stale by the pull.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
ENV DD_API_URL=http://localhost:8126

ENTRYPOINT ["ddguard-entrypoint"]
# no arguments means "show me what this thing does", not "usage error"
CMD ["demo"]
