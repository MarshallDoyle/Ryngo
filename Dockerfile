# Ryngo — multi-stage container, expected by the Cloud Build trigger
# at the repo root. The active code lives under mvp/; this Dockerfile
# scopes its build context with COPY paths starting with `mvp/` so the
# legacy Plinth-era design corpus (`adapters/`, `design/`, `spec/`, …)
# never enters the image.
#
# Cloud Run injects PORT=8080; server.js already reads process.env.PORT
# so no code change is needed across environments.

FROM node:20-alpine AS build
WORKDIR /app
# Build tools for native node modules. The tree-sitter family
# (tree-sitter + tree-sitter-typescript + tree-sitter-javascript +
# tree-sitter-python — added in Phase 5.1.0) compiles C++ via
# node-gyp on `npm ci`. Alpine needs python3 + make + g++ available.
# Build-stage only; the runtime stage stays slim because we copy
# the already-compiled node_modules over.
RUN apk add --no-cache python3 make g++
COPY mvp/package*.json ./
RUN npm ci
COPY mvp/ ./
RUN npm run build

FROM node:20-alpine AS runtime
RUN apk add --no-cache git ca-certificates
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist          ./dist
COPY --from=build /app/landing       ./landing
COPY --from=build /app/server.js     ./server.js
COPY --from=build /app/mcp-server.js ./mcp-server.js
COPY --from=build /app/lib           ./lib
COPY --from=build /app/package.json  ./package.json
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
