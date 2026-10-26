FROM ruby:4.0.0-slim-trixie

LABEL org.opencontainers.image.source="https://github.com/rojosinalma/cloche" \
      org.opencontainers.image.description="Share files and folders from a host with a browser as a gallery page, with previews, downloads, forms and callbacks into opencode sessions" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

ARG APP_UID=1000
ARG APP_GID=1000

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    7zip \
    libsqlite3-dev \
    zip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g "${APP_GID}" cloche \
    && useradd -u "${APP_UID}" -g cloche -d /app -s /usr/sbin/nologin cloche

WORKDIR /app

COPY Gemfile Gemfile.lock ./
RUN BUNDLE_FROZEN=true bundle install

COPY . .
RUN mkdir -p /app/data && chown -R cloche:cloche /app && chmod +x /app/bin/entrypoint

ENV RACK_ENV=production \
    DATABASE_PATH=/app/data/cloche.db \
    PORT=9292

EXPOSE 9292

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["ruby", "-rnet/http", "-e", "exit Net::HTTP.get_response(URI(\"http://127.0.0.1:#{ENV.fetch('PORT', 9292)}/health\")).code == '200' ? 0 : 1"]

USER cloche

ENTRYPOINT ["/app/bin/entrypoint"]
CMD ["bundle", "exec", "puma", "-C", "config/puma.rb", "config.ru"]
