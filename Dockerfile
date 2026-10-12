FROM node:22-slim

# edge-tts >=7.2.8 targets the retired v1 host that returns 403 since Oct 2026.
# Pin the v2 endpoint fix (rany2/edge-tts PR #491) from jonata's fork.
ARG EDGE_TTS_REF=8a5844c3a1d33e4e8f2f3e14535542c0d75d4248

RUN apt-get update && apt-get install -y \
    python3 python3-pip build-essential ffmpeg \
    && pip3 install --break-system-packages \
        "https://github.com/jonata/edge-tts/archive/${EDGE_TTS_REF}.tar.gz" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 8080

CMD ["node", "index.js"]
