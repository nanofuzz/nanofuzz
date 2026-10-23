import * as Config from "./Config";
import { languages } from "./ui/FuzzPanelController";

describe("Config", () => {
  afterEach(() => {
    Config.clearOverrides();
  });

  it("reads default configuration from package.json", () => {
    expect(Config.get("nanofuzz.rust.cargoPath", "fallback")).toBe("cargo");
    expect(Config.get("nanofuzz.oxcaml.dunePath", "fallback")).toBe("dune");
    expect(Config.get("nanofuzz.oxcaml.ocamloptPath", "fallback")).toBe(
      "ocamlopt"
    );
  });

  it("respects overrides", () => {
    Config.override("nanofuzz.rust.cargoPath", "/custom/path/to/cargo");
    expect(Config.get("nanofuzz.rust.cargoPath", "cargo")).toBe(
      "/custom/path/to/cargo"
    );
    Config.override("nanofuzz.oxcaml.dunePath", "/custom/path/to/dune");
    expect(Config.get("nanofuzz.oxcaml.dunePath", "dune")).toBe(
      "/custom/path/to/dune"
    );
  });

  it("registers rust and oxcaml in supported languages for FuzzPanelController", () => {
    expect(languages).toContain("rust");
    expect(languages).toContain("typescript");
    expect(languages).toContain("python");
    expect(languages).toContain("oxcaml");
  });
});
