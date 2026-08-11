import pkg from "../package.json";
import * as Config from "./Config";
import { getToolVersion } from "./ToolVersion";

describe("getToolVersion", () => {
  const originalName = Config.get("nanofuzz.name", "NaNofuzz");
  const originalVersion = process.env.NANOFUZZ_VERSION;

  afterEach(() => {
    Config.override("nanofuzz.name", originalName);
    if (originalVersion === undefined) {
      delete process.env.NANOFUZZ_VERSION;
    } else {
      process.env.NANOFUZZ_VERSION = originalVersion;
    }
  });

  it("uses the configured tool name and build-time version", () => {
    Config.override("nanofuzz.name", "StudyFuzz");
    process.env.NANOFUZZ_VERSION = "9.8.7";

    expect(getToolVersion()).toBe("StudyFuzz v9.8.7");
  });

  it("falls back to the package version outside a build", () => {
    delete process.env.NANOFUZZ_VERSION;

    expect(getToolVersion()).toBe(`${originalName} v${pkg.version}`);
  });
});
