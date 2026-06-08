FROM ghcr.io/puppeteer/puppeteer:21.0.0
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
WORKDIR /app
COPY package.json ./
RUN npm install
COPY pdf-server.js ./
EXPOSE 3000
CMD ["node", "pdf-server.js"]
