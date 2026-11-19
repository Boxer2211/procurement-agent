FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && cp src/db/schema.sql dist/db/ && cp -r src/prompts dist/prompts

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY data ./data
EXPOSE 8000
CMD ["node", "dist/cli.js", "serve", "--host", "0.0.0.0", "--port", "8000"]
