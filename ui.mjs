import { esc as escapeHtml } from "./lib/xml.js";

export { escapeHtml };
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function toast(message) {
  let element = $(".toast");
  if (!element) {
    element = document.createElement("div");
    element.className = "toast";
    document.body.append(element);
  }
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 1800);
}
