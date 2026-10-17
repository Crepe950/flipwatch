# FlipWatch — one image for both the web app and the polling worker.
FROM node:22-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
# Web app by default; the compose file runs the same image with the worker command for the poller.
# Started directly, not through `npm run`, so SIGTERM from `docker stop` reaches the app (npm's
# shell doesn't forward it) and it shuts down cleanly.
# APP_PASSWORD is optional (docker-compose.yml only publishes to this computer). exec keeps next as PID 1 so it
# still receives SIGTERM.
CMD ["sh", "-c", "exec node_modules/.bin/next start -H 0.0.0.0"]
