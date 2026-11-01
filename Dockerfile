# Demo deployment image (DEMO_MODE=1): serves the app from source with bun —
# NODE_ENV=production makes Bun.serve pre-bundle the frontend, and the
# checked-in demo-data snapshot rides along as the (read-only) demo dataset.
# The working copies live under /tmp and reset on every page load, so the
# container needs no volume and holds no durable state.
#
# The server binds loopback unless told otherwise; the container must answer
# on its public interface, under whatever domain the platform assigns, so it
# opens both up (src/server/requestGuard.ts). The cross-origin and body-type
# checks still apply.
FROM oven/bun:1.3-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04

WORKDIR /app

COPY package.json bun.lock ./
# --production skips devDependencies (electron and friends stay out).
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY demo-data ./demo-data

ENV NODE_ENV=production \
    DEMO_MODE=1 \
    SPECDRIVEN_ROOT=/tmp/specdriven-demo \
    SPECDRIVEN_LOG_FILE=0 \
    SPECDRIVEN_HOST=0.0.0.0 \
    SPECDRIVEN_ALLOWED_HOSTS=* \
    PORT=3000

USER bun
EXPOSE 3000

CMD ["bun", "src/index.ts"]
