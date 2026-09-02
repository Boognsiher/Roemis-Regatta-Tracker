FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV PORT=3000

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
