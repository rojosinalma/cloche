FROM ruby:3.3-slim

LABEL org.opencontainers.image.source="https://github.com/rojosinalma/cloche" \
      org.opencontainers.image.description="Share files and folders from a host with a browser as a gallery page, with previews, downloads, forms and callbacks into opencode sessions" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libsqlite3-dev \
    zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY Gemfile Gemfile.lock* ./
RUN bundle install

COPY . .

ENV RACK_ENV=production

EXPOSE 9292

CMD ["bundle", "exec", "puma", "-C", "config/puma.rb", "config.ru"]
