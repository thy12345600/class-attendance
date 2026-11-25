"use strict";

const form = document.getElementById("login");
const button = form.querySelector("button");
const status = document.getElementById("status");
const user = document.getElementById("username");
const password = document.getElementById("password");

form.addEventListener("submit", async event => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = "";
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user.value.trim(), password: password.value })
    });
    const result = await response.json();
    if (response.ok) {
      password.value = "";
      location.replace("/workspace");
      return;
    }
    status.textContent = result.error;
    password.focus();
    password.select();
  } catch {
    status.textContent = "暂时无法连接，请重试。";
  } finally {
    button.disabled = false;
  }
});
