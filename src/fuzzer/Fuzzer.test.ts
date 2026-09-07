import { Tester } from "./Fuzzer";
import { intOptions, initParser } from "./FuzzerTestHelper";
import { getToolVersion } from "../ToolVersion";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as JSONN from "../Jsonn";

describe("fuzzer: general", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("includes the tool version in initialized and persisted results", async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "nanofuzz-version-"));
    const outputFile = path.join(tmpdir, "results.json5");

    try {
      const results = await new Tester(
        "nanofuzz-study/examples/1.ts",
        "minValue",
        { ...intOptions, maxTests: 1, outputFile }
      ).testSync();
      const persisted = JSONN.parse(fs.readFileSync(outputFile, "utf8"));

      expect(results.toolVersion).toBe(getToolVersion());
      expect(persisted).toEqual(
        jasmine.objectContaining({ toolVersion: getToolVersion() })
      );
    } finally {
      fs.rmSync(tmpdir, { recursive: true });
    }
  });
});
