import { NodePath } from "@babel/traverse";
import { TSEntityName, Node } from "@babel/types";

/**
 * Replacer function for JSON.stringify that removes the parent property
 *
 * @param key The key of the property being stringified
 * @param value The value of the property being stringified
 * @returns undefined if key==='parent', otherwise value
 */
export function removeParents(key: string, value: unknown): unknown {
  if (key === "parent" || key === "parentPath") {
    return undefined;
  } else {
    return value;
  }
} // fn: removeParents()

/**
 * Gets a qualified identifier name for a given entity node
 *
 * @param node The node to get the identifier name for
 * @returns Qualified name as a string
 */
export function getIdentifierName(node: TSEntityName): string {
  switch (node.type) {
    case "Identifier": {
      return node.name;
    }
    case "TSQualifiedName": {
      return getIdentifierName(node.left) + "." + node.right.name;
    }
  }
} // fn: getIdentifierName()

/**
 * Determines whether an AST node is block scoped
 * Note: Requires that nodes have the parent property set
 *
 * @param `node` The node to check
 * @returns `true` if the node is block scoped, `false` otherwise
 */
export function isBlockScoped(node: NodePath<Node>): boolean {
  let thisNode = node;
  while (thisNode.parentPath) {
    if (thisNode.parentPath.node.type === "BlockStatement") {
      return true; // block scoped
    } else {
      thisNode = thisNode.parentPath; // move up the tree
    }
  }
  return false; // at root; block not encountered
} // fn: isBlockScoped()
