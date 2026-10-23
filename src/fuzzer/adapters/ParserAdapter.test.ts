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
public class MathUtil {
    public static int add(int a, int b) {
        return a + b;
    }
}
`;
    const tree = Parser.parse("java", javaSrc);
    expect(tree).not.toBeNull();
    const q = Parser.query(
      "java",
      "(method_declaration name: (identifier) @method.name)"
    );
    const matches = q.matches(tree!.rootNode);
    expect(matches.length).toBe(1);
    expect(matches[0].captures[0].node.text).toBe("add");
  });
});
