import * as TSWeb from "web-tree-sitter";
import { ProgramLanguage } from "../Fuzzer";

/**
 * This shim provide a more consistent interface for consumers of
 * `web-tree-sitter`.
 *
 * Note: when bundled, `web-tree-sitter` must be bundled as esm;
 * otherwise, it won't resolve resources like `web-tree-sitter.wasm`.
 */

// internal variables
const grammars: Record<string, GrammarData> = {};
const grammarsToLoad = ["tree-sitter-typescript", "tree-sitter-python"];
let loaded: "no" | "pending" | "yes" = "no";
let initPromise: Promise<void> | undefined; // init only once

/**
 * Init for web-tree-sitter
 */
export async function init(): Promise<void> {
  // Init only once
  if (loaded === "yes") {
    return;
  }
  if (loaded === "pending" && initPromise) {
    return initPromise;
  }

  // Construct and return a promise so that we init once
  initPromise = new Promise<void>((resolve, reject) => {
    loaded = "pending";
    let modulesUrl: string | undefined;
    TSWeb.Parser.init({
      locateFile(name: string, dir: string) {
        if (modulesUrl === undefined) {
          // front-end bundled `web-tree-sitter`
          if (dir.endsWith("/ui/")) {
            dir = `${dir.split("/").slice(0, -3).join("/")}/node_modules/web-tree-sitter/`;
          }
          modulesUrl = `${dir.split("/").slice(0, -2).join("/")}/`;
        }
        return `${dir}${name}`;
      },
    }).then(
      async (_fulfilled) => {
        for (const g of grammarsToLoad) {
          const url = `${modulesUrl}${g}/${g}.wasm`;
          const grammar = await TSWeb.Language.load(url);
          const parser = new TSWeb.Parser();
          parser.setLanguage(grammar);
          grammars[g] = { parser, grammar };
        }
        loaded = "yes";
        resolve();
      },
      (rejectReason) => {
        reject(rejectReason);
        loaded = "no";
        initPromise = undefined;
      }
    );
  });

  return initPromise;
}

/**
 * Parse program text
 *
 * @param `lang` programming language of text parse
 * @param `text` text to parse
 * @returns parse tree
 */
export function parse(lang: ProgramLanguage, text: string): Tree | null {
  if (loaded !== "yes") {
    throw new Error(
      loaded === "no"
        ? `init() not called prior to getParser()`
        : `init() must complete prior to calling getParser()`
    );
  }
  return _getGrammarOrThrow(_langToGrammarName(lang)).parser.parse(text);
}

/**
 * Returns a Query for a lang and querystring.
 *
 * @param `lang` programming language of text to query
 * @param `q` querystring
 * @returns new Query
 */
export function query(lang: ProgramLanguage, q: string): Query {
  return new TSWeb.Query(
    _getGrammarOrThrow(_langToGrammarName(lang)).grammar,
    q
  );
}

/**
 * Returns data for a grammar if it is loaded; otherwise, throws an Error.
 *
 * @param `grammarName` name of the grammar (e.g., tree-sitter-python)
 * @returns either GrammarData for that grammar on throws an Error
 */
function _getGrammarOrThrow(grammarName: string): GrammarData {
  if (!(grammarName in grammars)) {
    throw new Error(
      `Grammar ${grammarName} not loaded (loaded grammars: ${Object.keys(
        grammars
      )
        .map((g) => g)
        .join(", ")}`
    );
  }
  return grammars[grammarName];
}

/**
 * Returns a grammar nanme for a programming language
 *
 * @param `lang` programming language
 * @returns internal grammar name
 */
function _langToGrammarName(lang: ProgramLanguage): string {
  return `tree-sitter-${lang}`;
}

type Parser = TSWeb.Parser;
type Language = TSWeb.Language;
type GrammarData = {
  parser: Parser;
  grammar: Language;
};

export type Query = TSWeb.Query;
export type QueryCapture = TSWeb.QueryCapture;
export type Tree = TSWeb.Tree;
export type Node = TSWeb.Node;
export type SyntaxNode = TSWeb.Node;
