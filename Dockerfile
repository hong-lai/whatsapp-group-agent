FROM node:22.23.2-alpine3.24

WORKDIR /app

RUN apk upgrade --no-cache

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY packages ./packages
COPY services/ingest ./services/ingest
COPY services/api ./services/api
COPY apps/web ./apps/web

RUN npm run build:web

CMD ["npx", "tsx", "services/api/src/index.ts"]
