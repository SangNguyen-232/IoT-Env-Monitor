FROM node:26.12.0-alpine3.24

# Install timezone data and update npm.
RUN apk add --no-cache tzdata \
    && npm install --global npm@12.2.0

# Configure timezone and production environment.
ENV TZ=Asia/Ho_Chi_Minh \
    NODE_ENV=production

WORKDIR /app

# Install production dependencies.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy backend application.
COPY --chown=node:node . .

EXPOSE 3000

# Run as a non-root user.
USER node

CMD ["node", "src/index.js"]