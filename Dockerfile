# --- Build stage: compile TypeScript, prune to production deps ---------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- Runtime stage: Playwright image ships Chromium + system libs ------------
# Pinned to the exact Playwright version in package.json so the npm package and
# the preinstalled browser stay in lockstep. Browsers are baked into the image
# (PLAYWRIGHT_BROWSERS_PATH=/ms-playwright) — never downloaded at container start.
FROM mcr.microsoft.com/playwright:v1.61.1-noble AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

# dumb-init as PID 1: forwards signals (graceful SIGTERM) and reaps zombies.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json openapi.json ./

# Run as the image's non-root user.
USER pwuser

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
