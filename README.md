# 班级出勤汇总系统

用于登记、查询和汇总班级缺勤。管理员可以维护班级、导出 CSV，并创建、重置和停用录入员账号。

[GitHub Pages 公开演示](https://thy12345600.github.io/class-attendance/)可以试用登记、统计和导出。演示内置班级名称和虚构的缺勤记录，录入改动随刷新清除。

![自托管版本的登录界面](docs/preview.png)

## 本地运行

需要 Node.js 22 或更新版本。在项目目录执行：

```sh
node server.cjs --init admin
npm start
```

设置初始密码后，在同一台电脑打开 `http://127.0.0.1:8765/`。独立安装时先在班级管理中添加班级。本地运行数据保存在忽略目录 `.data/`。

## 结构

- `app.cjs` 提供登录、权限检查、出勤记录和 CSV 接口。
- `server.cjs` 是本地 Node.js 入口。
- `worker.mjs` 和 `wrangler.jsonc` 配置线上 Cloudflare Worker 与 SQLite Durable Object。
- `web/` 包含登录页面与工作台。
- `docs/` 包含 GitHub Pages 的静态公开演示。

自托管版本在服务端校验身份并保存共享数据。公开演示展示班级名称和示例缺勤记录，正式账号与实名缺勤数据由自托管服务保存。

```sh
npm run check
npm run build:cloud
```
