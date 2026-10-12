FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip && pip3 install --no-cache-dir --upgrade edge-tts --break-system-packages && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 8080

CMD ["node", "index.js"]
