# Ryngo MVP — multi-stage container.
#
# Build stage: install all deps, run `vite build` to produce ./dist
# Runtime stage: alpine + node + git, copy only what we need to run
#                `node server.js` against the built SPA.
#
# `git` package is required because lib/analyze.js shells out to
# `git clone --depth=1` against GitHub. ca-certificates lets the HTTPS
# clone resolve.
#
# Cloud Run injects PORT=8080; server.js already reads process.env.PORT
# so no code change.

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
RUN apk add --no-cache git ca-certificates
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist          ./dist
COPY --from=build /app/server.js     ./server.js
COPY --from=build /app/mcp-server.js ./mcp-server.js
COPY --from=build /app/lib           ./lib
COPY --from=build /app/package.json  ./package.json
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
