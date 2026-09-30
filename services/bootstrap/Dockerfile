FROM node:22-alpine
# hyperdht 6.34.0 : binaire `hyperdht` (bin.js). Les modules natifs (udx-native, sodium-native)
# sont livrés précompilés pour linux-x64 et linux-arm64.
RUN npm install -g hyperdht@6.34.0 && npm cache clean --force
USER node
ENTRYPOINT []
CMD ["hyperdht", "--bootstrap", "--host", "127.0.0.1"]
