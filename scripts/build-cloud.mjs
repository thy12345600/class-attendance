import { mkdir, readFile, writeFile } from "node:fs/promises";

const files = {
  login: ["login.html", "text/html; charset=utf-8"],
  loginJs: ["login.js", "text/javascript; charset=utf-8"],
  workspace: ["workspace.html", "text/html; charset=utf-8"],
  workspaceJs: ["workspace.js", "text/javascript; charset=utf-8"]
};
const pages = {};
for (const [name, [file, contentType]] of Object.entries(files)) {
  pages[name] = { body: await readFile(new URL("../web/" + file, import.meta.url), "utf8"), contentType };
}
await mkdir(new URL("../generated/", import.meta.url), { recursive: true });
await writeFile(new URL("../generated/pages.mjs", import.meta.url), "export default " + JSON.stringify(pages) + ";\n");
