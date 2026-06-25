# 实时产品报价小程序部署说明

## 推荐：Render

1. 把 `quote-mini-app` 这个文件夹上传到 GitHub 仓库。
2. 打开 Render，选择 `New > Web Service`，连接这个仓库。
3. 设置：
   - Root Directory：如果仓库根目录就是本文件夹，留空；否则填 `quote-mini-app`
   - Build Command：`npm install`
   - Start Command：`npm start`
4. 环境变量可选：
   - `SOURCE_URL`：报价源地址
   - `PRICE_MARKUP`：统一加价金额，默认 `50`
5. 部署完成后，Render 会给一个 `https://...onrender.com` 公网地址，直接发微信即可。

Render 官方文档说明 Node 服务常用 `npm install` 构建、`npm start` 启动。

## Railway

1. 把本文件夹上传到 GitHub 仓库。
2. Railway 选择 `Deploy from GitHub Repo`。
3. Railway 会识别 `package.json` 里的 `start` 脚本。
4. 部署完成后在 Settings 里生成 Public Domain。

## VPS / 宝塔 / Docker

在服务器上执行：

```bash
cd quote-mini-app
docker build -t quote-mini-app .
docker run -d --name quote-mini-app --restart unless-stopped -p 4173:4173 quote-mini-app
```

然后访问：

```text
http://服务器公网IP:4173
```

如果要用微信里更稳定的 HTTPS，建议绑定域名，再用 Nginx 配置 HTTPS 反向代理到 `127.0.0.1:4173`。

## 本地运行

```bash
npm start
```

访问：

```text
http://localhost:4173
```
