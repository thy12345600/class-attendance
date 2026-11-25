import { DurableObject } from "cloudflare:workers";
import app from "./app.cjs";
import pages from "./generated/pages.mjs";

class SqlMap {
  constructor(sql, namespace) {
    this.sql = sql;
    this.namespace = namespace;
  }

  get(key) {
    const row = this.sql.exec("SELECT value FROM app_state WHERE namespace = ? AND key = ?", this.namespace, key).toArray()[0];
    if (row) return JSON.parse(row.value);
  }

  set(key, value) {
    this.sql.exec(
      "INSERT INTO app_state (namespace, key, value) VALUES (?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value",
      this.namespace, key, JSON.stringify(value)
    );
  }

  delete(key) {
    this.sql.exec("DELETE FROM app_state WHERE namespace = ? AND key = ?", this.namespace, key);
  }

  *[Symbol.iterator]() {
    const rows = this.sql.exec("SELECT key, value FROM app_state WHERE namespace = ?", this.namespace).toArray();
    for (const row of rows) yield [row.key, JSON.parse(row.value)];
  }
}

function unavailable() {
  return new Response("暂时无法连接出勤服务。", {
    status: 503,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }
  });
}

export class AttendanceState extends DurableObject {
  constructor(context, env) {
    super(context, env);
    const storage = context.storage;
    const sql = storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS app_state (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key))");
    const store = new SqlMap(sql, "state");
    if (!store.get("admin") && env.ATTENDANCE_BOOTSTRAP) {
      const seed = JSON.parse(env.ATTENDANCE_BOOTSTRAP);
      storage.transactionSync(() => {
        store.set("admin", seed.admin);
        store.set("members", seed.members);
        store.set("database", seed.database);
        app.createAttendanceApp({ store, pages });
      });
    }
    if (store.get("admin")) {
      this.dispatch = app.createAttendanceApp({
        store, pages, sessions: new SqlMap(sql, "sessions"), attempts: new SqlMap(sql, "attempts")
      });
    }
  }

  async fetch(request) {
    if (!this.dispatch) return unavailable();
    const origin = new URL(request.url);
    const secure = origin.protocol === "https:";
    const incoming = {
      method: request.method,
      url: request.url,
      siteOrigin: origin.origin,
      secure,
      headers: Object.fromEntries(request.headers),
      socket: { remoteAddress: request.headers.get("CF-Connecting-IP") || "local" },
      iterator: () => request.body || [],
      resume() {}
    };
    let response;
    const outgoing = {
      headersSent: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
        this.headersSent = true;
      },
      end(body) {
        response = new Response(body, { status: this.status, headers: this.headers });
      }
    };
    await this.dispatch(incoming, outgoing);
    return response || unavailable();
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      url.protocol = "https:";
      return Response.redirect(url, 308);
    }
    return env.ATTENDANCE_STATE.getByName("class-attendance").fetch(request);
  }
};
