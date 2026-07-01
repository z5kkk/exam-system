FROM node:22-alpine

WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装依赖（使用国内镜像加速）
RUN npm install --registry=https://registry.npmmirror.com

# 复制应用代码
COPY . .

# 创建数据目录（用于持久化存储挂载）
RUN mkdir -p /app/data

EXPOSE 3000

# 默认数据目录 /app/data，可通过环境变量覆盖
ENV DB_PATH=/app/data/exam.db
ENV NODE_ENV=production

CMD ["node", "server.js"]
