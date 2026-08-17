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
