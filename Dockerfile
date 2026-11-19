FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV NODE_ENV=production
ENV PORT=8080
# Accounts and profile pictures live here; mount a persistent volume on /data.
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server/index.js"]
