FROM node:22-alpine
# blind-push-gateway-cli 0.2.0 (binaire `blind-push-gateway`), dépend de firebase-admin.
RUN npm install -g blind-push-gateway-cli@0.2.0 && npm cache clean --force
RUN mkdir -p /data /config /secrets && chown node:node /data
USER node
VOLUME ["/data"]
CMD ["blind-push-gateway", "run", "--config", "/config/config.json", "--storage", "/data", "--dry-run"]
