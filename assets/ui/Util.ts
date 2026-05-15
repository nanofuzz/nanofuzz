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

export function assertNonreachable(x: never): never {
  throw new Error(`Non-reachable code executed: ${x}`);
}

/**
 * Returns true if the DOM node is hidden using the 'hidden' class.
 *
 * @param e The DOM node to check for the 'hidden' class
 * @returns true if the DOM node is hidden; false otherwise
 */
export function isHidden(e: HTMLElement) {
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
} // !!!!!!
