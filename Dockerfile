FROM homebridge/homebridge:latest

ENV PUPPETEER_CACHE_DIR=/root/.cache/puppeteer
ENV DEBIAN_FRONTEND=noninteractive

# Chrome shared-library dependencies.
# Uses Swiss mirror — archive.ubuntu.com is unreliable from some hosts.
RUN sed -i 's|http://archive.ubuntu.com/ubuntu/|http://ch.archive.ubuntu.com/ubuntu/|g' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       libnspr4 libnss3 libasound2t64 libgbm1 \
    && rm -rf /var/lib/apt/lists/*

# Pre-download Chrome for the pinned puppeteer 24.39.1.
# The plugin is installed by homebridge's startup script at runtime (via
# the /homebridge bind mount), but Chrome must be baked into the image
# because /root/.cache/puppeteer is not persisted across recreates.
RUN npm install -g puppeteer@24.39.1 \
    && npx puppeteer browsers install chrome \
    && npm uninstall -g puppeteer

WORKDIR /homebridge
