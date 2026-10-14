# syntax=docker/dockerfile:1

# 1. Web app: the same `npm ci && npm run build` CI runs.
# node:22-alpine, pinned by digest; let Renovate/Dependabot bump it.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# 2. Go binary, static (no cgo), with the web build embedded.
# golang:1.27-alpine, pinned by digest; let Renovate/Dependabot bump it.
FROM golang:1.27-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/dispatch ./cmd/dispatch \
 && mkdir -p /out/data

# 3. Runtime: distroless, non-root, nothing but the binary. No shell and no
# network client, by design: a compromise gets no interpreter to run and no
# downloader to fetch a second stage or exfiltrate over. Health checks must
# use the built-in check below, which Docker runs by direct exec and needs no
# shell, or an external `HTTP GET /healthz` probe on port 8080 (see README).
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/dispatch /usr/local/bin/dispatch
COPY --from=build --chown=65532:65532 /out/data /data
ENV LISTEN_ADDR=:8080 \
    DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]
USER 65532:65532
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/dispatch", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/dispatch"]
CMD ["serve"]
