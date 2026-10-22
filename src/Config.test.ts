import * as Config from "./Config";
import { languages } from "./ui/FuzzPanelController";

describe("Config", () => {
  afterEach(() => {
    Config.clearOverrides();
  });

  it("reads default configuration from package.json", () => {
    expect(Config.get("nanofuzz.rust.cargoPath", "fallback")).toBe("cargo");
  });

  it("respects overrides", () => {
    Config.override("nanofuzz.rust.cargoPath", "/custom/path/to/cargo");
    expect(Config.get("nanofuzz.rust.cargoPath", "cargo")).toBe(
      "/custom/path/to/cargo"
    );
  });

  it("registers rust in supported languages for FuzzPanelController", () => {
    expect(languages).toContain("rust");
    expect(languages).toContain("typescript");
    expect(languages).toContain("python");
  });
});
