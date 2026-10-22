import { ConsoleIsolator } from "./ConsoleIsolator";

describe("ConsoleIsolator", () => {
  let isolator: ConsoleIsolator | undefined;

  afterEach(() => {
    if (isolator) {
      isolator.restore();
      isolator = undefined;
    }
  });

  it("captures non-cli console and stdout calls", () => {
    isolator = ConsoleIsolator.activate({ isDebug: () => false });

    console.log("regular log message");
    console.info("info message");
    console.warn("warning message");
    console.debug("debug message");
    console.error("error message");
    process.stdout.write("stdout stream message\n");

    const logs = isolator.getCapturedLogs();
    expect(logs.length).toBe(6);
    expect(logs[0].channel).toBe("log");
    expect(logs[0].message).toBe("regular log message");
    expect(logs[1].channel).toBe("info");
    expect(logs[1].message).toBe("info message");
    expect(logs[2].channel).toBe("warn");
    expect(logs[2].message).toBe("warning message");
    expect(logs[3].channel).toBe("debug");
    expect(logs[3].message).toBe("debug message");
    expect(logs[4].channel).toBe("error");
    expect(logs[4].message).toBe("error message");
    expect(logs[5].channel).toBe("stdout");
    expect(logs[5].message).toBe("stdout stream message\n");
  });

  it("permits CLI output through asCli and helper methods", () => {
    const iso = ConsoleIsolator.activate({ isDebug: () => false });
    isolator = iso;

    iso.asCli(() => {
      iso.log("direct cli log");
      iso.info("direct cli info");
      iso.warn("direct cli warn");
      iso.error("direct cli error");
    });

    expect(iso.getCapturedLogs().length).toBe(0);
  });

  it("clears captured logs via clearCapturedLogs", () => {
    isolator = ConsoleIsolator.activate({ isDebug: () => false });

    console.log("sample log");
    expect(isolator.getCapturedLogs().length).toBe(1);

    isolator.clearCapturedLogs();
    expect(isolator.getCapturedLogs().length).toBe(0);
  });

  it("restores original console methods on restore", () => {
    const origLog = console.log;
    const origStdoutWrite = process.stdout.write;

    isolator = ConsoleIsolator.activate({ isDebug: () => false });
    expect(console.log).not.toBe(origLog);
    expect(process.stdout.write).not.toBe(origStdoutWrite);

    isolator.restore();
    expect(console.log).toBe(origLog);
    expect(process.stdout.write).toBe(origStdoutWrite);
    isolator = undefined;
  });
});
