"use strict";

const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);

const cookieName = "attendance_session";
const sessionLife = 8 * 60 * 60 * 1000;
const attemptWindow = 15 * 60 * 1000;
const types = new Set(["旷课", "请假", "迟到", "早退"]);
const usernamePattern = /^[a-zA-Z0-9_-]{1,32}$/;
const recordFields = ["id", "date", "class", "name", "type", "lesson", "remark", "status"];
const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer"
};


function passwordIsValid(password) {
  return typeof password === "string" && password.length >= 10 && password.length <= 128;
}

function normalizedUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validCredential(account) {
  return account && typeof account.username === "string" && usernamePattern.test(account.username) &&
    /^[0-9a-f]{48}$/.test(account.salt) && /^[0-9a-f]{128}$/.test(account.key);
}

async function makeCredential(username, password) {
  const salt = crypto.randomBytes(24);
  const key = await scrypt(password, salt, 64);
  return { username, salt: salt.toString("hex"), key: key.toString("hex") };
}

async function correctPassword(password, account) {
  const key = await scrypt(password, Buffer.from(account.salt, "hex"), 64);
  return crypto.timingSafeEqual(key, Buffer.from(account.key, "hex"));
}

function createAttendanceApp({ store, sessions = new Map(), attempts = new Map(), pages }) {

  let admin = store.get("admin");
  if (!validCredential(admin)) throw new Error("管理员配置有误。");
  let members = loadMembers();
  let database = loadDatabase();

  function send(response, status, contentType, body = "", headers = {}) {
    response.writeHead(status, { ...securityHeaders, "Content-Type": contentType, ...headers });
    response.end(body);
  }

  function json(response, status, value, headers) {
    send(response, status, "application/json; charset=utf-8", JSON.stringify(value), headers);
  }

  function redirect(response, target) {
    send(response, 303, "text/plain; charset=utf-8", "", { Location: target });
  }

  function readSession(request) {
    const cookie = request.headers.cookie || "";
    const token = cookie.match(/(?:^|;\s*)attendance_session=([0-9a-f]{64})(?:;|$)/)?.[1];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expires <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return { token, session };
  }

  function createSession(response, request, username, role) {
    const previous = readSession(request);
    if (previous) sessions.delete(previous.token);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { username, role, expires: Date.now() + sessionLife });
    json(response, 200, { ok: true }, {
      "Set-Cookie": cookieName + "=" + token + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + sessionLife / 1000 + (request.secure ? "; Secure" : "")
    });
  }

  function revokeSessions(username) {
    for (const [token, session] of sessions) {
      if (session.username === username) sessions.delete(token);
    }
  }

  function findAccount(username) {
    if (username === normalizedUsername(admin.username)) return { credential: admin, role: "admin" };
    const member = members.get(username);
    if (member?.enabled) return { credential: member, role: "member" };
    return null;
  }

  function accountList() {
    return [
      { username: admin.username, role: "admin", enabled: true },
      ...Array.from(members.values(), ({ username, enabled }) => ({ username, role: "member", enabled }))
    ];
  }

  function loadMembers() {
    const list = store.get("members");
    if (list === undefined) return new Map();
    if (!Array.isArray(list)) throw new Error("无法读取录入员账号。");
    const entries = new Map();
    for (const account of list) {
      if (!validCredential(account) || typeof account.enabled !== "boolean") throw new Error("录入员账号配置有误。");
      const username = normalizedUsername(account.username);
      if (entries.has(username) || username === normalizedUsername(admin.username)) throw new Error("录入员账号重复。");
      entries.set(username, account);
    }
    return entries;
  }

  function saveMember(account) {
    const updated = new Map(members).set(normalizedUsername(account.username), account);
    store.set("members", [...updated.values()]);
    members = updated;
  }

  async function manageMember(request, response, action, username) {
    const input = await readBody(request, 4096);
    if (!readSession(request)) return json(response, 401, { error: "登录状态已变更，请重新登录。" });

    if (action === "add") username = normalizedUsername(input?.username);
    const original = members.get(username);
    if (action === "add") {
      if (!usernamePattern.test(username)) return json(response, 400, { error: "请输入 1 至 32 位英文、数字、下划线或短横线组成的账号。" });
      if (username === normalizedUsername(admin.username) || original) return json(response, 409, { error: "该用户名已存在。" });
    } else if (!original) {
      return json(response, 404, { error: "找不到该录入员账号。" });
    }

    if (action === "status") {
      if (typeof input?.enabled !== "boolean") return json(response, 400, { error: "账号状态有误。" });
      saveMember({ ...original, enabled: input.enabled });
      if (!input.enabled) revokeSessions(original.username);
      return json(response, 200, { accounts: accountList() });
    }

    if (!passwordIsValid(input?.password) || input.password !== input.confirm) {
      return json(response, 400, { error: "密码须为 10 至 128 个字符，两次输入须一致。" });
    }
    const updated = await makeCredential(original?.username || username, input.password);
    if (!readSession(request)) return json(response, 401, { error: "登录状态已变更，请重新登录。" });
    if (members.get(username) !== original) {
      return json(response, 409, { error: action === "add" ? "该用户名已存在。" : "该账号已更新，请刷新后重试。" });
    }
    saveMember({ ...updated, enabled: original?.enabled ?? true });
    if (original) revokeSessions(original.username);
    return json(response, action === "add" ? 201 : 200, { accounts: accountList() });
  }

  function loginGate(key, limit) {
    const now = Date.now();
    let history = attempts.get(key);
    if (!history || history.expires <= now) {
      history = { count: 0, expires: now + attemptWindow };
    }
    if (history.count >= limit) return false;
    history.count += 1;
    attempts.set(key, history);
    return true;
  }

  async function readBody(request, limit) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      length += chunk.length;
      if (length > limit) {
        request.resume();
        throw Object.assign(new Error("提交内容过大。"), { status: 413 });
      }
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("提交格式有误。"), { status: 400 });
    }
  }

  function shortText(value, max, required = false) {
    return typeof value === "string" && value.length <= max && (!required || value.trim().length > 0);
  }

  function validRecord(record, classes) {
    if (!record || !shortText(record.id, 80, true) || !shortText(record.name, 40, true) ||
        !classes.has(record.class) || !types.has(record.type) ||
        typeof record.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(record.date) ||
        !shortText(record.lesson, 40) || !shortText(record.remark, 180) || record.status !== "pass") return false;
    const parsedDate = new Date(record.date);
    return !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === record.date;
  }

  function validDatabase(value) {
    if (!value || !Array.isArray(value.classes) || !Array.isArray(value.records)) return false;
    if (value.classes.length > 500 || value.records.length > 10000) return false;
    const classes = new Set(value.classes);
    if (classes.size !== value.classes.length || !value.classes.every(name => shortText(name, 36, true))) return false;
    const ids = new Set();
    for (const record of value.records) {
      if (!validRecord(record, classes) || ids.has(record.id)) return false;
      ids.add(record.id);
    }
    return true;
  }

  function saveDatabase(classes, records) {
    const updated = { revision: database.revision + 1, classes, records };
    store.set("database", updated);
    database = updated;
    return database;
  }

  function csvCell(value) {
    let text = String(value ?? "");
    if (/^\s*[=+@\-＝＋＠－]|^[\r\n\t]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }

  function downloadCsv(response, filename, rows) {
    const csv = "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n");
    return send(response, 200, "text/csv; charset=utf-8", csv, {
      "Content-Disposition": "attachment; filename=\"attendance.csv\"; filename*=UTF-8''" + encodeURIComponent(filename)
    });
  }

  function exportCsv(response, filters) {
    const name = (filters.get("name") || "").trim().toLowerCase();
    const selectedClass = filters.get("class");
    const selectedType = filters.get("type");
    const columns = ["日期", "班级", "节次", "姓名", "缺勤类型", "备注"];
    const records = database.records.filter(record =>
      record.name.toLowerCase().includes(name) &&
      (!selectedClass || record.class === selectedClass) &&
      (!selectedType || record.type === selectedType)
    ).sort((first, second) => second.date.localeCompare(first.date))
      .map(record => [record.date, record.class, record.lesson, record.name, record.type, record.remark]);
    const date = new Intl.DateTimeFormat("sv-SE").format(new Date());
    return downloadCsv(response, "缺勤明细-" + date + ".csv", [columns, ...records]);
  }

  function loadDatabase() {
    const value = store.get("database");
    if (value !== undefined) {
      if (!validDatabase(value) || !Number.isInteger(value.revision) || value.revision < 0) throw new Error("无法读取出勤数据文件。");
      return value;
    }
    return {
      revision: 0,
      classes: [],
      records: []
    };
  }

  async function handle(request, response) {
    pruneExpired();
    if (!request.siteOrigin) return send(response, 400, "text/plain; charset=utf-8", "无法识别此网址。");
    const url = new URL(request.url, request.siteOrigin);
    const route = url.pathname;
    const method = request.method;
    const loggedIn = readSession(request);
    const isAdmin = loggedIn?.session.role === "admin";

    if (method === "GET") {
      if (route === "/") return loggedIn ? redirect(response, "/workspace") : sendPage(response, pages.login);
      if (route === "/assets/login.js") return sendPage(response, pages.loginJs);
      if (route === "/workspace") return loggedIn ? sendPage(response, pages.workspace) : redirect(response, "/");
      if (route === "/assets/workspace.js" || route === "/api/data" || route === "/api/session" ||
          route === "/api/accounts" || route === "/api/export" || route === "/api/classes/export") {
        if (!loggedIn) return json(response, 401, { error: "请先登录。" });
        if (route === "/assets/workspace.js") return sendPage(response, pages.workspaceJs);
        const { username, role } = loggedIn.session;
        if (route === "/api/data") return json(response, 200, { ...database, username, role });
        if (route === "/api/session") return json(response, 200, { username, role, revision: database.revision });
        if (!isAdmin) return json(response, 403, { error: "仅管理员可以执行此操作。" });
        if (route === "/api/export") return exportCsv(response, url.searchParams);
        if (route === "/api/classes/export") {
          return downloadCsv(response, "班级名单.csv", [["班级"], ...database.classes.map(name => [name])]);
        }
        return json(response, 200, { accounts: accountList() });
      }
    }

    if (method === "POST" || method === "PUT") {
      if (request.headers.origin !== request.siteOrigin || request.headers["content-type"]?.split(";")[0] !== "application/json") {
        return json(response, 403, { error: "请求来源有误，请从登录页重新打开。" });
      }

      if (method === "POST" && route === "/api/login") {
        const input = await readBody(request, 2048);
        const username = normalizedUsername(input?.username);
        const address = request.socket.remoteAddress;
        const key = "login-account:" + address + ":" + (usernamePattern.test(username) ? username : "invalid:");
        if (!loginGate("login-address:" + address, 80) || !loginGate(key, 8)) {
          return json(response, 429, { error: "尝试次数过多，请 15 分钟后重试。" });
        }
        const account = findAccount(username);
        const password = input?.password;
        if (!passwordIsValid(password) || !await correctPassword(password, account?.credential || admin) ||
            !account || findAccount(username)?.credential !== account.credential) {
          return json(response, 401, { error: "用户名或密码错误。" });
        }
        attempts.delete(key);
        return createSession(response, request, account.credential.username, account.role);
      }

      if (!loggedIn) return json(response, 401, { error: "请先登录。" });

      if (method === "POST" && route === "/api/logout") {
        sessions.delete(loggedIn.token);
        return json(response, 200, { ok: true }, {
          "Set-Cookie": cookieName + "=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" + (request.secure ? "; Secure" : "")
        });
      }

      if (method === "POST" && route === "/api/records") {
        const input = await readBody(request, 4096);
        if (!readSession(request)) return json(response, 401, { error: "请重新登录。" });
        if (!validRecord(input, new Set(database.classes))) return json(response, 400, { error: "缺勤记录格式有误。" });
        const previous = database.records.find(record => record.id === input.id);
        if (previous) {
          if (recordFields.every(field => previous[field] === input[field])) return json(response, 200, database);
          return json(response, 409, { error: "记录已保存，请刷新页面后再修改。" });
        }
        if (database.records.length >= 10000) return json(response, 409, { error: "已达到 10000 条记录的上限。" });
        const record = Object.fromEntries(recordFields.map(field => [field, input[field]]));
        return json(response, 201, saveDatabase(database.classes, [record, ...database.records]));
      }

      const addMember = method === "POST" && route === "/api/accounts";
      const updateMember = method === "PUT" && route.match(/^\/api\/accounts\/([a-z0-9_-]{1,32})\/(status|password)$/);
      const changeAdminPassword = method === "POST" && route === "/api/password";
      const updateData = method === "PUT" && route === "/api/data";
      if (!isAdmin && (addMember || updateMember || changeAdminPassword || updateData)) {
        return json(response, 403, { error: "仅管理员可以执行此操作。" });
      }
      if (addMember) return manageMember(request, response, "add");
      if (updateMember) return manageMember(request, response, updateMember[2], updateMember[1]);

      if (changeAdminPassword) {
        const input = await readBody(request, 2048);
        if (!passwordIsValid(input?.next) || input.next !== input.confirm || input.current === input.next) {
          return json(response, 400, { error: "请输入 10 至 128 个字符的新密码，两次输入须一致，且须与当前密码不同。" });
        }
        const key = "password:" + loggedIn.token;
        if (!loginGate(key, 8)) return json(response, 429, { error: "尝试次数过多，请 15 分钟后重试。" });
        const current = admin;
        if (!passwordIsValid(input.current) || !await correctPassword(input.current, current)) {
          return json(response, 403, { error: "当前密码错误。" });
        }
        const updated = await makeCredential(current.username, input.next);
        if (admin !== current || !readSession(request)) return json(response, 401, { error: "登录状态已变更，请重新登录。" });
        store.set("admin", updated);
        admin = updated;
        revokeSessions(admin.username);
        attempts.delete(key);
        return createSession(response, request, admin.username, "admin");
      }

      if (updateData) {
        const input = await readBody(request, 8 * 1024 * 1024);
        if (!readSession(request)) return json(response, 401, { error: "请重新登录。" });
        if (!validDatabase(input)) return json(response, 400, { error: "记录或班级数据格式有误。" });
        if (input.revision !== database.revision) {
          return json(response, 409, { error: "另一个页面已更新数据。已载入最新记录，请核对后重试。", database });
        }
        return json(response, 200, saveDatabase(input.classes, input.records));
      }
    }

    return send(response, 404, "text/plain; charset=utf-8", "没有这个页面。");
  }

  function sendPage(response, page) {
    return send(response, 200, page.contentType, page.body);
  }


  let nextPrune = 0;
  function pruneExpired() {
    const now = Date.now();
    if (now < nextPrune) return;
    nextPrune = now + 60000;
    for (const [token, session] of sessions) if (session.expires <= now) sessions.delete(token);
    for (const [key, item] of attempts) if (item.expires <= now) attempts.delete(key);
  }

  return async function dispatch(request, response) {
    try {
      await handle(request, response);
    } catch (error) {
      if (response.headersSent) throw error;
      if (error.status) return json(response, error.status, { error: error.message });
      console.error("Attendance request failed", error?.name);
      return json(response, 500, { error: "服务暂时无法处理请求。" });
    }
  };
}

module.exports = { createAttendanceApp, makeCredential, passwordIsValid, usernamePattern };
