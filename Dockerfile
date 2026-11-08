FROM node:24.12.0-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig*.json ./
COPY src/shared ./src/shared
COPY services/signaling ./services/signaling
COPY scripts/create-invite.ts ./scripts/create-invite.ts
COPY .env.example ./.env
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.P2P_MULTIPLE_GROUPS_SIGNAL_PORT || process.env.PORT || 8787) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["npm", "run", "signal:start"]
