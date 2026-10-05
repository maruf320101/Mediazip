# ── Stage 1: Base image with Node.js + Python + ffmpeg ────────
FROM node:20-slim

# Install Python, pip, ffmpeg, curl, unzip (needed for yt-dlp, Deno & video merging)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    unzip \
    --no-install-recommends \
    && curl -fsSL https://deno.land/install.sh | sh \
    && mv /root/.deno/bin/deno /usr/local/bin/deno \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp, curl_cffi, yt-dlp-ejs (latest)
RUN pip3 install -U yt-dlp curl_cffi yt-dlp-ejs --break-system-packages

# ── Stage 2: App setup ──────────────────────────────────────────
WORKDIR /app

# Copy package files first (Docker layer cache)
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --omit=dev

# Copy all app files
COPY . .

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s \
  CMD node -e "require('http').get('http://localhost:3000/api/check', r => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start server
CMD ["node", "server.js"]
