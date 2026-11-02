import * as Parser from "./ParserAdapter";

describe("fuzzer/adapters/ParserAdapter: ", () => {
  beforeAll(async () => {
    await Parser.init();
  });

  it("parses Java code into a valid syntax tree", () => {
    const javaSrc = `
public class MathUtil {
    public static int add(int a, int b) {
        return a + b;
    }
}
`;
    const tree = Parser.parse("java", javaSrc);
    expect(tree).not.toBeNull();
    expect(tree?.rootNode.type).toBe("program");
    const classDecl = tree?.rootNode.descendantsOfType("class_declaration")[0];
    expect(classDecl).toBeDefined();
  });

  it("executes a query against Java syntax tree", () => {
    const javaSrc = `
package com.example;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public class MathUtil {
    /**
     * Adds two numbers.
     */
    public static int add(int a, int b) {
        return a + b;
    }

    public static List<String> filterNames(String[] names, Optional<String> prefix) {
        return List.of();
    }

    public void doNothing() {}
}
`;
    const tree = Parser.parse("java", javaSrc);
    expect(tree).not.toBeNull();
    const q = Parser.query(
      "java",
      `
(method_declaration
  (modifiers)? @method.mods
  type: (_) @method.return
  name: (identifier) @method.name
  parameters: (formal_parameters) @method.params) @method.item
`
    );
    const matches = q.matches(tree!.rootNode);
    expect(matches.length).toBe(3);

    const firstMatch = matches[0];
    const nameCap = firstMatch.captures.find((c) => c.name === "method.name");
    expect(nameCap?.node.text).toBe("add");

    const itemNode = firstMatch.captures.find(
      (c) => c.name === "method.item"
    )?.node;
    expect(itemNode?.previousNamedSibling?.type).toBe("block_comment");
    expect(itemNode?.previousNamedSibling?.text).toContain("Adds two numbers.");
    const typeCap = firstMatch.captures.find((c) => c.name === "method.return");
    expect(typeCap?.node.text).toBe("int");

    const paramsCap = firstMatch.captures.find(
      (c) => c.name === "method.params"
    );
    expect(paramsCap).toBeDefined();

    const paramNodes = Parser.getNamedChildrenNoComments(paramsCap!.node);
    expect(paramNodes.length).toBe(2);
    expect(paramNodes[0].type).toBe("formal_parameter");

    const secondMatch = matches[1];
    const secondParams = Parser.getNamedChildrenNoComments(
      secondMatch.captures.find((c) => c.name === "method.params")!.node
    );
    expect(secondParams[0].childForFieldName("type")?.type).toBe("array_type");
    const arrType = secondParams[0].childForFieldName("type")!;
    expect(arrType.childForFieldName("element")?.text).toBe("String");
    expect(arrType.childForFieldName("dimensions")?.text).toBe("[]");

    expect(secondParams[1].childForFieldName("type")?.type).toBe(
      "generic_type"
    );
    const genType = secondParams[1].childForFieldName("type")!;
    const typeArgs = genType.children.find((c) => c.type === "type_arguments");
    expect(typeArgs).toBeDefined();
    const argList = Parser.getNamedChildrenNoComments(typeArgs!);
    expect(argList[0].text).toBe("String");
  });

  it("parses Go code into a valid syntax tree and executes a query", () => {
    const goSrc = `
package mathutil

// Add sums two integers.
func Add(a int, b int) int {
    return a + b
}
`;
    const tree = Parser.parse("go", goSrc);
    expect(tree).not.toBeNull();
    expect(tree?.rootNode.type).toBe("source_file");
    const fnDecl = tree?.rootNode.descendantsOfType("function_declaration")[0];
    expect(fnDecl).toBeDefined();

    const q = Parser.query(
      "go",
      `
(function_declaration
  name: (identifier) @fn.name
  parameters: (parameter_list) @fn.params
  result: (type_identifier)? @fn.return) @fn.item
`
    );
    const matches = q.matches(tree!.rootNode);
    expect(matches.length).toBe(1);
    const nameCap = matches[0].captures.find((c) => c.name === "fn.name");
    expect(nameCap?.node.text).toBe("Add");
  });
});
