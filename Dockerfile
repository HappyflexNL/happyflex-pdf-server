# Basisimage gepind op exact dezelfde versie als de puppeteer-dependency in package.json.
# Geen `latest`, geen range: de browser is hier de zwaarste afhankelijkheid en een stille
# minor-sprong is precies wat een renderservice onvoorspelbaar maakt.
FROM ghcr.io/puppeteer/puppeteer:25.6.0

ENV NODE_ENV=production \
    PORT=3000 \
    PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

USER root
WORKDIR /app

COPY package.json package-lock.json ./

# De browser komt uit onze eigen gepinde puppeteer, niet uit het basisimage: dat pad is een
# eigenschap van het image en geen contract. `browsers install` is de vangnetregel — het
# basisimage kan PUPPETEER_SKIP_DOWNLOAD zetten, waardoor de postinstall niets zou doen.
RUN npm ci --omit=dev \
 && npx puppeteer browsers install chrome \
 && chown -R pptruser:pptruser /app

COPY --chown=pptruser:pptruser pdf-server.js ./
COPY --chown=pptruser:pptruser src ./src

USER pptruser
EXPOSE 3000

# Coolify en Docker kijken hiernaar. /health is bewust ongeauthenticeerd en meldt de
# browserstatus, niet alleen "express leeft".
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "pdf-server.js"]
