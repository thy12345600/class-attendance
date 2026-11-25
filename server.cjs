"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const readline = require("node:readline/promises");
const { createAttendanceApp, makeCredential, passwordIsValid, usernamePattern } = require("./app.cjs");

const port = Number(process.env.ATTENDANCE_PORT || "8765");
const runtime = path.resolve(process.env.ATTENDANCE_DATA_DIR || path.join(__dirname, ".data"));
const dataFiles = { admin: "admin.json", members: "members.json", database: "records.json" };
const hosts = new Set(["127.0.0.1:" + port, "localhost:" + port]);

const store = {
  get(key) {
    const file = path.join(runtime, dataFiles[key]);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  },
  set(key, value) {
    const file = path.join(runtime, dataFiles[key]);
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(value) + "\n");
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
};

function page(name, contentType) {
  return { body: fs.readFileSync(path.join(__dirname, "web", name)), contentType };
}

async function initialize(username) {
  if (!usernamePattern.test(username || "")) throw new Error("请输入 1 至 32 位英文、数字、下划线或短横线组成的账号。");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const file = path.join(runtime, dataFiles.admin);
  if (fs.existsSync(file)) throw new Error("管理员已设置。请登录网页后修改密码。");
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  const password = await input.question("请输入管理员密码（至少 10 个字符）\n");
  input.close();
  if (!passwordIsValid(password)) throw new Error("密码长度应为 10 至 128 个字符。");
  const account = await makeCredential(username, password);
  fs.writeFileSync(file, JSON.stringify(account) + "\n", { flag: "wx", mode: 0o600 });
  console.log("管理员已设置。");
}

function start() {
  const dispatch = createAttendanceApp({
    store,
    pages: {
      login: page("login.html", "text/html; charset=utf-8"),
      loginJs: page("login.js", "text/javascript; charset=utf-8"),
      workspace: page("workspace.html", "text/html; charset=utf-8"),
      workspaceJs: page("workspace.js", "text/javascript; charset=utf-8")
    }
  });
  const server = http.createServer((request, response) => {
    request.siteOrigin = hosts.has(request.headers.host) ? "http://" + request.headers.host : null;
    dispatch(request, response).catch(() => response.destroy());
  });
  server.requestTimeout = 30_000;
  server.listen(port, "127.0.0.1", () => console.log("访问 http://127.0.0.1:" + port + "/"));
}

(async () => {
  if (process.argv[2] === "--init") await initialize(process.argv[3]);
  else start();
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
