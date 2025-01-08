import {
  AST_NODE_TYPES,
  EntityName,
  Node,
} from "@typescript-eslint/types/dist/ast-spec";

/**
 * Replacer function for JSON.stringify that removes the parent property
 *
 * @param key The key of the property being stringified
 * @param value The value of the property being stringified
 * @returns undefined if key==='parent', otherwise value
 */
export function removeParents(key: string, value: unknown): unknown {
  if (key === "parent") {
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
export function getIdentifierName(node: EntityName): string {
  switch (node.type) {
    case AST_NODE_TYPES.Identifier: {
      return node.name;
    }
    case AST_NODE_TYPES.TSQualifiedName: {
      return getIdentifierName(node.left) + "." + node.right.name;
    }
  }
} // fn: getIdentifierName()

/**
 * Determines whether an AST node is block scoped
 * Note: Requires that nodes have the parent property set
 *
 * @param node The node to check
 * @returns true if the node is block scoped, false otherwise
 */
export function isBlockScoped(node: Node): boolean {
  let thisNode: Node = node;
  while (!(thisNode.parent === undefined)) {
    if (thisNode.parent.type === AST_NODE_TYPES.BlockStatement) {
      return true; // block scoped
    } else {
      thisNode = thisNode.parent; // move up the tree
    }
  }
  return false; // at root; block not encountered
} // fn: isBlockScoped()
