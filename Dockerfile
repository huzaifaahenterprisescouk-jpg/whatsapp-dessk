FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=3000 DATA_FILE=/app/data/db.json
EXPOSE 3000
CMD ["node", "server.js"]
