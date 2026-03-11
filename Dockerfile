FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy TypeScript config and source
COPY tsconfig.json ./
COPY src/ ./src/

# Install dev deps for build, build, then remove dev deps
RUN npm install typescript --save-dev && \
    npx tsc && \
    npm prune --production

# Expose port (Railway sets PORT env var)
EXPOSE ${PORT:-3003}

CMD ["node", "dist/index.js"]
