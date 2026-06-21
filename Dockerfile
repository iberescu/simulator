# Playwright base image ships Chromium + all OS deps, matched to the pinned playwright version.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install dependencies first (better layer caching). better-sqlite3 uses prebuilt binaries.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/data && chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 8080
CMD ["node", "src/index.js"]
