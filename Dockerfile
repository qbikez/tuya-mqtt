FROM node:alpine

WORKDIR /app

COPY ["package.json", "package-lock.json", "./"]

RUN npm ci

COPY . .

RUN npx patch-package

CMD ["npm", "run", "start"]