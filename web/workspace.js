"use strict";

const byId = id => document.getElementById(id);
const attendanceTypes = [
  { name: "旷课", style: "tone-absent", stat: "statAbsent" },
  { name: "请假", style: "tone-leave", stat: "statLeave" },
  { name: "迟到", style: "tone-late", stat: "statLate" },
  { name: "早退", style: "tone-early", stat: "statEarly" }
];

function calendarDate(daysAgo = 0) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return date.getFullYear() + "-" + month + "-" + day;
}

function setWorkspaceNotice(message) {
  const target = byId("workspaceNotice");
  target.textContent = message;
  target.hidden = !message;
}

async function api(url, method = "GET", data) {
  try {
    const options = { method };
    if (data !== undefined) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(data);
    }
    const response = await fetch(url, options);
    if (response.status === 401) {
      byId("app").hidden = true;
      location.replace("/");
      return { ok: false, error: "登录已过期，请重新登录。" };
    }
    const result = await response.json();
    return { ...result, ok: response.ok };
  } catch {
    return { ok: false, error: "暂时无法连接，请重试。" };
  }
}

async function saveDB(updated, adding = false) {
  if (saving) return { ok: false, error: "正在保存，请稍后重试。" };
  saving = true;
  const result = await api(adding ? "/api/records" : "/api/data", adding ? "POST" : "PUT", updated);
  saving = false;
  if (result.ok) database = result;
  if (result.database) {
    database = result.database;
    renderAll();
  }
  return result;
}

function setNotice(target, message, isError = false) {
  target.textContent = message;
  target.toggleAttribute("data-error", isError);
}

function setOptions(select, values, firstLabel) {
  const previous = select.value;
  const options = values.map(value => new Option(value, value));
  if (firstLabel !== undefined) options.unshift(new Option(firstLabel, ""));
  select.replaceChildren(...options);
  if (Array.from(select.options).some(option => option.value === previous)) select.value = previous;
}

let database;
let isAdmin = false;
let saving = false;
let synchronizing = false;
let editedRecord = null;
let newRecordDraft = null;
const typeNames = attendanceTypes.map(type => type.name);
const recordForm = byId("recordForm");
const formNotice = byId("formNotice");
const filterName = byId("filterName");
const filterClass = byId("filterClass");
const filterType = byId("filterType");
const filterFrom = byId("filterFrom");
const filterTo = byId("filterTo");
const classesDialog = byId("classesDialog");

function activeRecords() {
  return database.records.filter(record => record.status === "pass");
}

function dateRangeError() {
  if (!filterFrom.validity.valid || !filterTo.validity.valid) return "请输入有效的日期。";
  if (filterFrom.value && filterTo.value && filterFrom.value > filterTo.value) return "开始日期不能晚于结束日期。";
  return "";
}

function filteredRecords() {
  const query = filterName.value.trim().toLowerCase();
  return activeRecords().filter(record =>
    record.name.toLowerCase().includes(query) &&
    (!filterClass.value || record.class === filterClass.value) &&
    (!filterType.value || record.type === filterType.value) &&
    (!filterFrom.value || record.date >= filterFrom.value) &&
    (!filterTo.value || record.date <= filterTo.value)
  ).sort((first, second) => second.date.localeCompare(first.date));
}

function calcStat() {
  const records = activeRecords();
  byId("statTotal").textContent = records.length;
  attendanceTypes.forEach(type => {
    byId(type.stat).textContent = records.filter(record => record.type === type.name).length;
  });
}

function renderClassChart() {
  const counts = new Map(database.classes.map(name => [name, 0]));
  activeRecords().forEach(record => counts.set(record.class, (counts.get(record.class) || 0) + 1));
  const classes = [...counts].sort((first, second) => second[1] - first[1]);
  const maximum = Math.max(1, ...counts.values());
  const rows = classes.map(([name, count]) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "chart-row";
    row.setAttribute("aria-label", name + "，" + count + " 人次");
    row.setAttribute("aria-pressed", String(filterClass.value === name));

    const label = document.createElement("span");
    label.className = "chart-name";
    label.textContent = name;
    const track = document.createElement("span");
    track.className = "chart-track";
    track.setAttribute("aria-hidden", "true");
    const bar = document.createElement("span");
    bar.className = "chart-bar";
    bar.style.width = (100 * count / maximum) + "%";
    track.append(bar);
    const figure = document.createElement("span");
    figure.className = "chart-value";
    figure.textContent = count;
    row.append(label, track, figure);
    row.addEventListener("click", () => {
      filterName.value = "";
      filterType.value = "";
      filterClass.value = name;
      renderFilters();
      location.hash = "records";
      byId("records").scrollIntoView({ block: "start" });
      filterClass.focus({ preventScroll: true });
    });
    return row;
  });
  byId("classChart").replaceChildren(...rows);
}

function textCell(row, value, className) {
  const cell = row.insertCell();
  cell.textContent = value;
  if (className) cell.className = className;
  return cell;
}

function renderPassed() {
  const rows = byId("recordRows");
  const invalidDates = dateRangeError();
  const dateError = byId("dateFilterError");
  dateError.textContent = invalidDates;
  dateError.hidden = !invalidDates;
  [filterFrom, filterTo].forEach(input => {
    if (invalidDates) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  });
  const records = invalidDates ? [] : filteredRecords();
  const total = activeRecords().length;
  byId("recordCount").textContent = records.length + " / " + total + " 条";
  byId("exportCsv").disabled = records.length === 0;
  rows.replaceChildren();

  if (!records.length) {
    const message = total ? "没有符合筛选条件的记录。" : "暂无缺勤记录。";
    const cell = textCell(rows.insertRow(), invalidDates ? "请调整日期范围后查看记录。" : message, "empty");
    cell.colSpan = isAdmin ? 7 : 6;
    return;
  }

  records.forEach(record => {
    const row = rows.insertRow();
    textCell(row, record.date);
    textCell(row, record.name, "person");
    textCell(row, record.class);
    const badge = document.createElement("span");
    const type = attendanceTypes.find(item => item.name === record.type);
    badge.className = "badge " + (type?.style || "");
    badge.textContent = record.type;
    row.insertCell().append(badge);
    textCell(row, record.lesson || "—");
    textCell(row, record.remark || "—");

    if (!isAdmin) return;
    const actions = row.insertCell();
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "text-button";
    edit.textContent = "编辑";
    edit.setAttribute("aria-label", "编辑 " + record.name + " 的记录");
    edit.addEventListener("click", () => editRecord(record));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button danger";
    remove.textContent = "删除";
    remove.setAttribute("aria-label", "删除 " + record.name + " 的记录");
    remove.addEventListener("click", () => deleteRecord(record));
    actions.append(edit, remove);
  });
}

function renderFilters() {
  renderPassed();
  renderClassChart();
}

function renderAll() {
  setOptions(byId("recClass"), database.classes, "选择班级");
  setOptions(filterClass, database.classes, "全部班级");
  calcStat();
  renderFilters();
}

function resetRecordForm() {
  editedRecord = null;
  newRecordDraft = null;
  recordForm.reset();
  byId("recDate").value = calendarDate();
  byId("entryTitle").textContent = "登记缺勤";
  byId("saveLabel").textContent = "保存缺勤记录";
  byId("resetRecord").textContent = "清空";
  setNotice(formNotice, "");
}

async function submitRecord(event) {
  event.preventDefault();
  if (saving) return;
  const name = byId("recName").value.trim();
  const className = byId("recClass").value;
  const date = byId("recDate").value;
  const type = byId("recType").value;

  if (!name || !date || !database.classes.includes(className) || !typeNames.includes(type)) {
    setNotice(formNotice, "请填写有效的日期、班级、姓名和缺勤类型。", true);
    return;
  }

  const previous = database.records.find(record => record.id === editedRecord?.id);
  if (editedRecord && !previous) {
    setNotice(formNotice, "这条记录已被删除。请取消编辑后重新登记。", true);
    return;
  }
  if (editedRecord && ["date", "class", "name", "type", "lesson", "remark"].some(field => editedRecord[field] !== previous[field])) {
    setNotice(formNotice, "这条记录已更新。请取消编辑，打开最新记录后再修改。", true);
    return;
  }
  const record = {
    date,
    class: className,
    name,
    type,
    lesson: byId("recLesson").value.trim(),
    remark: byId("recRemark").value.trim(),
    status: "pass"
  };
  if (previous) {
    record.id = previous.id;
  } else {
    const contents = JSON.stringify(record);
    if (newRecordDraft?.contents !== contents) newRecordDraft = { contents, id: crypto.randomUUID() };
    record.id = newRecordDraft.id;
  }
  const controls = recordForm.querySelectorAll("input, select, button");
  controls.forEach(control => { control.disabled = true; });
  const result = previous
    ? await saveDB({ ...database, records: database.records.map(item => item.id === record.id ? record : item) })
    : await saveDB(record, true);
  controls.forEach(control => { control.disabled = false; });
  if (!result.ok) {
    setNotice(formNotice, result.error, true);
    return;
  }
  resetRecordForm();
  renderAll();
  setNotice(formNotice, previous ? "已保存修改" : "已保存并计入统计");
}

function editRecord(record) {
  if (saving) return;
  editedRecord = record;
  newRecordDraft = null;
  byId("recDate").value = record.date;
  byId("recClass").value = record.class;
  byId("recName").value = record.name;
  byId("recType").value = record.type;
  byId("recLesson").value = record.lesson;
  byId("recRemark").value = record.remark;
  byId("entryTitle").textContent = "编辑缺勤记录";
  byId("saveLabel").textContent = "保存修改";
  byId("resetRecord").textContent = "取消编辑";
  setNotice(formNotice, "");
  byId("entry").scrollIntoView({ block: "start" });
  byId("recName").focus({ preventScroll: true });
}

async function deleteRecord(record) {
  if (!window.confirm("删除 " + record.name + " 的这条缺勤记录？")) return;
  const result = await saveDB({ ...database, records: database.records.filter(item => item.id !== record.id) });
  if (!result.ok) {
    setWorkspaceNotice(result.error);
    return;
  }
  setWorkspaceNotice("");
  if (editedRecord?.id === record.id) resetRecordForm();
  renderAll();
  filterName.focus({ preventScroll: true });
}

function renderClassList() {
  const records = activeRecords();
  const classes = database.classes.map(name => {
    const row = document.createElement("li");
    const label = document.createElement("span");
    const count = document.createElement("small");
    label.textContent = name;
    count.textContent = records.filter(record => record.class === name).length + " 条记录";
    row.append(label, count);
    return row;
  });
  byId("classList").replaceChildren(...classes);
}

async function addClass(event) {
  event.preventDefault();
  const input = byId("className");
  const name = input.value.trim();
  const notice = byId("classNotice");
  if (!name || database.classes.includes(name)) {
    setNotice(notice, name ? "这个班级已存在。" : "请输入班级名称。", true);
    return;
  }
  const result = await saveDB({ ...database, classes: [...database.classes, name] });
  renderClassList();
  if (!result.ok) {
    setNotice(notice, result.error, true);
    return;
  }
  input.value = "";
  renderAll();
  setNotice(notice, "已新增 " + name);
  input.focus();
}

function exportCsv() {
  const filters = new URLSearchParams({
    name: filterName.value,
    class: filterClass.value,
    type: filterType.value,
    from: filterFrom.value,
    to: filterTo.value
  });
  const link = document.createElement("a");
  link.href = "/api/export?" + filters;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

const accountsDialog = byId("accountsDialog");
const accountForm = byId("accountForm");
const accountName = byId("newAccountName");
const accountPassword = byId("newAccountPassword");
const accountsNotice = byId("accountsNotice");
let resetAccount = null;
let managingAccounts = false;

function showAccountForm(username = null) {
  resetAccount = username;
  accountForm.reset();
  byId("accountNameField").hidden = Boolean(username);
  accountName.required = !username;
  byId("accountFormTitle").textContent = username ? "重置密码 · " + username : "新增录入员账号";
  byId("accountPasswordLabel").textContent = username ? "新密码" : "初始密码";
  byId("submitAccount").textContent = username ? "保存新密码" : "新增账号";
  byId("cancelAccountReset").hidden = !username;
}

function renderAccounts(accounts) {
  const rows = accounts.map(account => {
    const row = document.createElement("li");
    const info = document.createElement("span");
    const label = document.createElement("span");
    label.className = "account-row-name";
    label.textContent = account.username;
    const status = document.createElement("small");
    status.textContent = account.role === "admin" ? "管理员" : (account.enabled ? "录入员 · 已启用" : "录入员 · 已停用");
    info.append(label, status);
    row.append(info);
    if (account.role === "admin") return row;

    const actions = document.createElement("span");
    actions.className = "account-actions";
    const reset = accountButton("重置密码", account.username, () => {
      if (managingAccounts) return;
      setNotice(accountsNotice, "");
      showAccountForm(account.username);
      accountPassword.focus();
    });
    const statusLabel = account.enabled ? "停用" : "启用";
    const changeStatus = accountButton(statusLabel, account.username, async () => {
      if (managingAccounts) return;
      if (account.enabled && !window.confirm("停用 " + account.username + "？对方将退出登录，已录入的记录会保留。")) return;
      await updateAccounts("/api/accounts/" + encodeURIComponent(account.username.toLowerCase()) + "/status",
        "PUT", { enabled: !account.enabled }, "已" + statusLabel + " " + account.username + "。");
    });
    if (account.enabled) changeStatus.classList.add("danger");
    actions.append(reset, changeStatus);
    row.append(actions);
    return row;
  });
  byId("accountList").replaceChildren(...rows);
}

function accountButton(label, username, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button";
  button.textContent = label;
  button.setAttribute("aria-label", label + " " + username);
  button.addEventListener("click", action);
  return button;
}

async function updateAccounts(url = "/api/accounts", method = "GET", data, message = "") {
  if (managingAccounts) return false;
  managingAccounts = true;
  const controls = accountForm.querySelectorAll("button, input");
  controls.forEach(control => { control.disabled = true; });
  setNotice(accountsNotice, method === "GET" ? "正在读取账号…" : "");
  const result = await api(url, method, data);
  controls.forEach(control => { control.disabled = false; });
  managingAccounts = false;
  if (result.ok) renderAccounts(result.accounts);
  setNotice(accountsNotice, result.ok ? message : result.error, !result.ok);
  return result.ok;
}

byId("openAccounts").addEventListener("click", async () => {
  showAccountForm();
  accountsDialog.showModal();
  await updateAccounts();
  if (accountsDialog.open) accountName.focus();
});
accountsDialog.addEventListener("close", () => accountForm.reset());
byId("cancelAccountReset").addEventListener("click", () => {
  showAccountForm();
  setNotice(accountsNotice, "");
  accountName.focus();
});
accountForm.addEventListener("submit", async event => {
  event.preventDefault();
  const target = resetAccount;
  const username = accountName.value.trim();
  const password = accountPassword.value;
  const confirm = byId("confirmAccountPassword").value;
  if (password !== confirm) {
    setNotice(accountsNotice, "两次输入的密码不一致。", true);
    return;
  }
  const url = target ? "/api/accounts/" + encodeURIComponent(target.toLowerCase()) + "/password" : "/api/accounts";
  const message = target ? "已重置 " + target + " 的密码，对方需要重新登录。" : "已新增录入员 " + username.toLowerCase() + "。";
  const ok = await updateAccounts(url, target ? "PUT" : "POST", { username, password, confirm }, message);
  if (ok) {
    showAccountForm();
    if (accountsDialog.open) accountName.focus();
  }
});

function updateNavigation() {
  const records = location.hash === "#records";
  byId("navOverview").removeAttribute("aria-current");
  byId("navRecords").removeAttribute("aria-current");
  byId(records ? "navRecords" : "navOverview").setAttribute("aria-current", "location");
}

byId("today").dateTime = calendarDate();
byId("today").textContent = new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(new Date());
setOptions(byId("recType"), typeNames, "选择缺勤类型");
setOptions(filterType, typeNames, "全部类型");
recordForm.addEventListener("submit", submitRecord);
byId("resetRecord").addEventListener("click", resetRecordForm);
filterName.addEventListener("input", renderPassed);
filterClass.addEventListener("change", renderFilters);
filterType.addEventListener("change", renderPassed);
filterFrom.addEventListener("input", renderPassed);
filterTo.addEventListener("input", renderPassed);
byId("resetFilters").addEventListener("click", () => {
  filterName.value = "";
  filterClass.value = "";
  filterType.value = "";
  filterFrom.value = "";
  filterTo.value = "";
  renderFilters();
});
byId("exportCsv").addEventListener("click", exportCsv);
byId("openClasses").addEventListener("click", () => {
  byId("classForm").reset();
  setNotice(byId("classNotice"), "");
  renderClassList();
  classesDialog.showModal();
  byId("className").focus();
});
byId("classForm").addEventListener("submit", addClass);
byId("logout").addEventListener("click", async () => {
  const result = await api("/api/logout", "POST", {});
  if (result.ok) location.replace("/");
  else setWorkspaceNotice(result.error);
});
const passwordDialog = byId("passwordDialog");
const passwordForm = byId("passwordForm");
const passwordNotice = byId("passwordNotice");
byId("openPassword").addEventListener("click", () => {
  passwordForm.reset();
  setNotice(passwordNotice, "");
  passwordDialog.showModal();
  byId("currentPassword").focus();
});
passwordForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = passwordForm.querySelector('[type="submit"]');
  button.disabled = true;
  setNotice(passwordNotice, "");
  const result = await api("/api/password", "POST", {
    current: byId("currentPassword").value,
    next: byId("nextPassword").value,
    confirm: byId("confirmPassword").value
  });
  button.disabled = false;
  if (result.ok) passwordForm.reset();
  setNotice(passwordNotice, result.ok ? "密码已更新，此账号的其他登录已退出。" : result.error, !result.ok);
});
window.addEventListener("hashchange", updateNavigation);

async function initializeWorkspace() {
  const result = await api("/api/data");
  if (!result.ok) {
    byId("loadError").hidden = false;
    return;
  }
  database = result;
  isAdmin = result.role === "admin";
  byId("accountTag").textContent = result.username + (isAdmin ? " · 管理员" : " · 录入员");
  byId("accountTag").title = byId("accountTag").textContent;
  ["openClasses", "openAccounts", "openPassword", "exportCsv", "recordOperations"].forEach(id => {
    byId(id).hidden = !isAdmin;
  });
  renderAll();
  resetRecordForm();
  updateNavigation();
  byId("app").hidden = false;
}

async function synchronizeRecords() {
  if (!database || synchronizing || saving || document.hidden) return;
  synchronizing = true;
  const session = await api("/api/session");
  if (session.ok && session.revision > database.revision && !saving) {
    const result = await api("/api/data");
    if (result.ok && result.revision > database.revision && !saving) {
      database = result;
      renderAll();
    }
  }
  synchronizing = false;
}

window.addEventListener("pageshow", event => {
  if (event.persisted) {
    byId("app").hidden = true;
    location.reload();
  }
});
window.addEventListener("focus", synchronizeRecords);
document.addEventListener("visibilitychange", synchronizeRecords);
setInterval(synchronizeRecords, location.protocol === "https:" ? 5000 : 2500);
initializeWorkspace();
