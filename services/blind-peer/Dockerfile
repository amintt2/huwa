FROM node:22-alpine
# blind-peer-cli 1.15.1 fournit les binaires `blind-peer` (Node) et `blind-peer-bare` (Bare).
RUN npm install -g blind-peer-cli@1.15.1 && npm cache clean --force
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
CMD ["blind-peer", "--storage", "/data"]
