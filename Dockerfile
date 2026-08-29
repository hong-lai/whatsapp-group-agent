FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY web ./web

RUN npm run build:web

CMD ["npx", "tsx", "--import", "./src/telemetry.ts", "src/index.ts"]
