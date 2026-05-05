FROM node:20-alpine

# Install git (needed for git_commit_push tool)
RUN apk add --no-cache git openssh-client

WORKDIR /mcp

COPY package*.json ./
RUN npm install --production

COPY index.js ./

ENV REPO_PATH=/repo
ENV PORT=3100

EXPOSE 3100

CMD ["node", "index.js"]
