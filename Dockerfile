FROM node:20-alpine

RUN apk add --no-cache git openssh-client

WORKDIR /mcp

COPY package*.json ./
RUN npm install --production

COPY index.js ./
COPY orchestrator.js ./

ENV REPO_PATH=/repo
ENV PORT=3100

EXPOSE 3100

CMD ["sh", "-c", "node index.js & node orchestrator.js"]
