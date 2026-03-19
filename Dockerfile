FROM homebridge/homebridge:latest

# Install dependencies required for headless Chrome / Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2t64 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Download Chrome for Puppeteer
ENV PUPPETEER_CACHE_DIR=/root/.cache/puppeteer
RUN npx -y puppeteer browsers install chrome

# Append plugin install to the default startup script
# This runs after Homebridge setup completes, so /var/lib/homebridge exists
RUN printf '\n# Auto-install homebridge-loxone-control plugin\nif [ ! -d "/var/lib/homebridge/node_modules/homebridge-loxone-control" ]; then\n  echo "Installing homebridge-loxone-control plugin..."\n  cd /var/lib/homebridge && npm install --save homebridge-loxone-control@1.6.1\nfi\n' >> /defaults/startup.sh

WORKDIR /homebridge
