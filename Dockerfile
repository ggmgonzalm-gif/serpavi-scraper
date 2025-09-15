# Usa Playwright con navegadores y deps ya instalados
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app
# Si tienes package-lock.json, descomenta la siguiente línea y copia ambos
# COPY package.json package-lock.json ./
COPY package.json ./

# Instala deps (producción)
RUN npm ci --omit=dev || npm i --only=prod

# Copia el servidor
COPY server.mjs ./

EXPOSE 3000
CMD ["node", "server.mjs"]
