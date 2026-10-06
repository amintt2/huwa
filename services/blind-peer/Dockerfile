# Relais Huwa : blind peer Holepunch (bibliothèque blind-peer@3.15.1) + politique Huwa (policy.js).
# Les modules natifs (rocksdb-native, udx-native, sodium-native) sont livrés précompilés (image Debian/glibc : les prébuilds musl d’Alpine faisaient planter le relais) pour
# linux-x64 / linux-arm64 (glibc et musl).
FROM node:22-bookworm-slim
# rocksdb-native (linux-arm64) a besoin de libatomic.so.1, absent de l’image slim.
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js policy.js ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV STORAGE=/data PORT=49738 HEALTH_PORT=8080 NODE_ENV=production
VOLUME ["/data"]
EXPOSE 49738/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
