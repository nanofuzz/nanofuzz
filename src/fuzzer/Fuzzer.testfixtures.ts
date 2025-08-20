/**
 * Fuzz target that alters its input - used to verify
 * that recorded fuzzer input is not altered by the target
 */
export function testChangeInput(obj: { a: number }) {
  (obj as any).b = 1;
}

/**
 * Fuzz targets with return type `void` that returns undefined
 */
export function testStandardVoidReturnUndefined(x: number): void {
  const y = x - 1;
}
export const testArrowVoidReturnUndefined = (x: number): void => {
  const y = x - 1;
};

/**
 * Fuzz targets with return type `void` that returns number
 */
export function testStandardVoidReturnNumber(x: number): void {
  if (x % 2) {
    x;
  }
  if (x % 3) {
    x;
  }
  if (x % 5) {
    x;
  }
  const y: unknown = x;
  return y as void;
}
export const testArrowVoidReturnNumber = (x: number): void => {
  const y: unknown = x;
  return y as void;
};

/**
 * Fuzz targets with return type `void` that throw an exception
 */
export function testStandardVoidReturnException(x: number): void {
  throw new Error("Random error");
}
export const testArrowVoidReturnException = (x: number): void => {
  throw new Error("Random error");
};

/**
 * Fuzz targets with literal arguments
 */
export function testStandardVoidLiteralArgs(n: 5, n2: 5[]): void {
  return;
}
export const testArrowVoidLiteralArgs = (n: 5, n2: 5[]): void => {
  return;
};

/**
 * Fuzz targets with union arguments
 */
type hellos = "hello" | "bonjour" | "olá" | "ciao" | "hej";
type stringOrNumber = string | number;
type maybeString = string | undefined;
export function testStandardUnionArgs(
  a: stringOrNumber,
  b: maybeString[]
): boolean | undefined {
  return;
}
export const testArrowUnionArgs = (
  a: stringOrNumber,
  b: maybeString[]
): boolean | undefined => {
  return;
};
