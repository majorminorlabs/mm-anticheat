FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY docs ./docs
COPY README.md ./
EXPOSE 3000
CMD ["node", "src/server.mjs"]
