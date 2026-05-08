FROM node:20-alpine

# System deps for git, ssh, and Playwright/Chromium
RUN apk add --no-cache \
  git openssh-client \
  chromium nss freetype harfbuzz ca-certificates ttf-freefont \
  # Chromium runtime deps
  udev xvfb

# Tell Playwright to use system Chromium instead of downloading its own
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /mcp

COPY package*.json ./
RUN npm install --production

COPY index.js ./
COPY orchestrator.js ./

ENV REPO_PATH=/repo
ENV PORT=3100

EXPOSE 3100

CMD ["sh", "-c", "node index.js & node orchestrator.js"]
