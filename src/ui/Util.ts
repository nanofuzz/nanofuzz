import { Judgment } from "../../src/fuzzer/oracles/Types";

export function getElementByIdOrThrow(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Element with id "${id}" not found`);
  }
  return element;
}

export function getElementByIdWithTypeOrThrow<T extends HTMLElement>(
  id: string,
  type: {
    new (): T;
  }
): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Element with id "${id}" not found`);
  }
  if (!(element instanceof type)) {
    throw new Error(`Element with id "${id}" is not of type ${type.name}`);
  }
  return element;
}

/**
 * Returns true if the DOM node is hidden using the 'hidden' class.
 *
 * @param e The DOM node to check for the 'hidden' class
 * @returns true if the DOM node is hidden; false otherwise
 */
export function isHidden(e: Element) {
  return e.classList.contains("hidden");
} // fn: isHidden()

/**
 * Toggles whether an element is hidden or not
 *
 * @param e DOM element to toggle
 */
export function toggleHidden(e: Element) {
  if (e.classList.contains("hidden")) {
    e.classList.remove("hidden");
  } else {
    e.classList.add("hidden");
  }
} // fn: toggleHidden()

/**
 * Hides a DOM element
 *
 * @param e DOM element to hide
 */
export function hide(e: Element) {
  e.classList.add("hidden");
} // fn: hide()

/**
 * Shows a DOM element
 *
 * @param e DOM element to hide
 */
export function show(e: Element) {
  e.classList.remove("hidden");
} // fn: show()

/**
 * Returns a judgment icon for a given judgment.
 *
 * @param j judgment
 * @param inline if false, do not create an icon for inlining in text
 * @returns HTML representing a judgment icon
 */
export function judgmentToIcon(j: Judgment, inline: boolean = true): string {
  return `<span><span class="codicon codicon-${
    j === "pass" ? "pass" : j === "fail" ? "error" : "circle"
  }${inline ? " inline" : ""}"></span></span>`;
}

// !!!!!!
export function simpleToast(msg: string): void {
  // Create the snackbar
  const snackbarRoot = document.querySelector("#snackbarRoot");
  if (!snackbarRoot) return;
  const snackbar = document.createElement("div");
  snackbar.classList.add("snackbar");

  // Add the message
  snackbar.innerHTML = `<big>${msg}</big>`;

  // Position the snackbar at the bottom of the view
  snackbar.style.position = "fixed";
  snackbar.style.bottom = "5px";

  // Attach and show the snackbar
  snackbar.classList.add("snackbarShow");
  snackbarRoot.parentElement?.append(snackbar);

  // Remove the snackbar after 4s
  setTimeout(async () => {
    snackbar.remove();
  }, 4000);
} // fn: simpleToast

/**
 * Adapted from: escape-goat/index.js
 *
 * Unescapes an HTML string.
 *
 * @param html HTML to unescape
 * @returns unescaped string
 */
export function htmlUnescape(html: string) {
  return html
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
} // fn: htmlUnescape()

/**
 * Adapted from: escape-goat/index.js
 *
 * Escapes a string for use in HTML.
 *
 * @param str string to escape
 * @returns escaped string
 */
export function htmlEscape(str: string) {
  return str === undefined
    ? "undefined"
    : str
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
} // fn: htmlEscape()
