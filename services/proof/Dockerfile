FROM rust:1.98.1-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY vendor ./vendor
COPY src ./src
RUN cargo build --locked --release --bin cadence-proof

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG BUILD_SHA
RUN test -n "$BUILD_SHA"
ENV BUILD_SHA=$BUILD_SHA
COPY --from=builder /app/target/release/cadence-proof /usr/local/bin/cadence-proof
USER 65532:65532
EXPOSE 3000
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/cadence-proof"]
