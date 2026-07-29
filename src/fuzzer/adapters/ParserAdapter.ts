/* eslint-disable @typescript-eslint/no-require-imports */
import * as TSWeb from "web-tree-sitter";
import { ProgramLanguage } from "../Fuzzer";

/**
 * This module provide a more consistent interface for consumers of
 * `tree-sitter` regardless of whether they are running in a webview
 * (`web-tree-sitter`) or as node modules (`tree-sitter`).
 *
 * This is necessary because, e.g., `ValueMapper` uses `tree-sitter`
 * and runs in electron, node, and webviews. Performance of
 * `tree-sitter` is better than `web-tree-sitter`, but we can't
 * use its native bindings from the Webview... hence, we need
 * `web-tree-sitter` for the webviews.
 *
 * Note: if bundled, `web-tree-sitter` must be bundled as an esm
 * module; otherwise, it won't resolve its `web-tree-sitter.wasm`.
 */

// internal variables
const parsers: Record<string, Parser> = {};
const grammars = ["tree-sitter-typescript", "tree-sitter-python"];
let loaded: "no" | "pending" | "yes" = "no";

// if this is node, auto-init the parsers
if (!process.env.TARGET_WEB) {
  initNode();
} else {
  initWeb(); // start the init process
}

/**
 * Init for node tree-sitter
 */
export function initNode(): void {
  if (loaded === "yes") {
    return;
  }
  if (process.env.TARGET_WEB) {
    throw new Error(`initNode is not for webviews`);
  } else {
    loaded = "pending";
    const TSNode = require("tree-sitter");
    grammars.forEach(async (g) => {
      const parser = new TSNode();
      parser.setLanguage(
        g === `tree-sitter-typescript` ? require(g).typescript : require(g)
      );
      parsers[g] = parser;
    });
    loaded = "yes";
  }
}

let initPromise: Promise<void> | undefined;

/**
 * Init for web-tree-sitter
 */
export async function initWeb(): Promise<void> {
  if (loaded === "yes") {
    return;
  }
  if (!process.env.TARGET_WEB) {
    throw new Error(`initWeb is only for webviews`);
  }
  if (loaded === "pending" && initPromise) {
    return initPromise;
  }

  initPromise = new Promise<void>((resolve, reject) => {
    loaded = "pending";
    let urlDir: string;
    TSWeb.Parser.init({
      locateFile(name: string, dir: string) {
        urlDir = dir;
        return `${dir}/${name}`;
      },
    }).then(
      async (_fulfilled) => {
        for (const g of grammars) {
          const url = `${urlDir}/${g}.wasm`;
          const grammar = await TSWeb.Language.load(url);
          const parser = new TSWeb.Parser();
          parser.setLanguage(grammar);
          parsers[g] = parser;
        }
        loaded = "yes";
        resolve();
      },
      (rejectReason) => {
        reject(rejectReason);
      }
    );
  });

  return initPromise;
}

/**
 * Parse text
 *
 * @param `lang` language to parse
 * @param `text` text to parse
 * @returns parse tree
 */
export function parse(
  lang: Omit<ProgramLanguage, "*">,
  text: string
): Tree | null {
  if (loaded !== "yes") {
    throw new Error(
      loaded === "no"
        ? `init() not called prior to getParser()`
        : `init() must complete prior to calling getParser()`
    );
  }
  const grammar = `tree-sitter-${lang}`;
  if (!(grammar in parsers)) {
    throw new Error(
      `Grammar ${grammar} not present (available grammars: ${Object.keys(
        parsers
      )
        .map((g) => g)
        .join(", ")}`
    );
  }
  return parsers[grammar].parse(text);
}

type Parser = {
  parse(text: string): Tree | null;
};

/**
 * Interface to bridge the two tree-sitters. Adapted from:
 * https://nachawati.me/blog/2023/08/17/tree-sitter-api-differences-node-and-web-workaround/
 * https://gist.github.com/nachawati/351cba7c0b9adff2b75a2fafe3e73ac3#file-tree-sitter-api-ts
 */
export type Point = {
  row: number;
  column: number;
};

export type Range = {
  startPosition: Point;
  endPosition: Point;
  startIndex: number;
  endIndex: number;
};

export type Edit = {
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;
  startPosition: Point;
  oldEndPosition: Point;
  newEndPosition: Point;
};

export interface SyntaxNode {
  tree: Tree;
  type: string;
  text: string;
  startPosition: Point;
  endPosition: Point;
  startIndex: number;
  endIndex: number;
  parent: SyntaxNode | null;
  children: Array<SyntaxNode>;
  namedChildren: Array<SyntaxNode>;
  childCount: number;
  namedChildCount: number;
  firstChild: SyntaxNode | null;
  firstNamedChild: SyntaxNode | null;
  lastChild: SyntaxNode | null;
  lastNamedChild: SyntaxNode | null;
  nextSibling: SyntaxNode | null;
  nextNamedSibling: SyntaxNode | null;
  previousSibling: SyntaxNode | null;
  previousNamedSibling: SyntaxNode | null;

  hasChanges: boolean; // modified
  hasError: boolean; // modified
  isMissing: boolean; // modified
  toString(): string;
  child(index: number): SyntaxNode | null;
  namedChild(index: number): SyntaxNode | null;

  walk(): TreeCursor;
}

export interface TreeCursor {
  nodeType: string;
  nodeText: string;
  nodeIsNamed: boolean;
  nodeIsMissing: boolean;
  startPosition: Point;
  endPosition: Point;
  startIndex: number;
  endIndex: number;

  reset(node: SyntaxNode): void;
  gotoParent(): boolean;
  gotoFirstChild(): boolean;
  gotoFirstChildForIndex(index: number): boolean;
  gotoNextSibling(): boolean;
}

export interface Tree {
  readonly rootNode: SyntaxNode;

  //edit(delta: Edit): Tree; // modified
  walk(): TreeCursor;
  getChangedRanges(other: Tree): Range[];
  //getEditedRange(other: Tree): Range; // modified
}

export function currentFieldName(cursor: any) {
  return typeof cursor.currentFieldName === "function"
    ? cursor.currentFieldName.bind(cursor)()
    : cursor.currentFieldName;
}

export function currentNode(cursor: any) {
  return typeof cursor.currentNode === "function"
    ? cursor.currentNode.bind(cursor)()
    : cursor.currentNode;
}

export function childForFieldName(
  syntaxNode: SyntaxNode,
  fieldName: string
): SyntaxNode | null {
  return childrenForFieldName(syntaxNode, fieldName).next().value ?? null;
}

export function* childrenForFieldName(
  syntaxNode: SyntaxNode,
  fieldName: string
): IterableIterator<SyntaxNode> {
  const cursor = syntaxNode.walk();
  if (cursor.gotoFirstChild()) {
    do {
      if (currentFieldName(cursor) === fieldName) yield currentNode(cursor);
    } while (cursor.gotoNextSibling());
  }
}
