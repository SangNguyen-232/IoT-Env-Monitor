FROM node:20-alpine

RUN apk add --no-cache tzdata
ENV TZ=Asia/Ho_Chi_Minh \
    NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

EXPOSE 3000

USER node

CMD ["node", "index.js"]