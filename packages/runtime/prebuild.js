const npmpkg = require("./package.json");
const nanopkg = require("../../package.json");
const copyfiles = require("copyfiles");
const fs = require("fs");
const rimraf = require("rimraf");

// Write out the version file
fs.writeFileSync(
  "./src/build.json",
  JSON.stringify(
    {
      versions: {
        runtime: npmpkg.version,
        fuzzer: nanopkg.version,
      },
    },
    null,
    2
  )
);

// Clean the build folder
rimraf.sync("./build");

// Copy the license file
copyfiles(["../../LICENSE", "."], true /* flat */, () =>
  console.log("done copying license file")
);

// Copy the Fuzzer Types file
copyfiles(["../../src/fuzzer/Types.ts", "./src/fuzzer"], true /* flat */, () =>
  console.log("done copying fuzzer types")
);

// Copy the TypeScript analysis Types file
copyfiles(
  [
    "../../src/fuzzer/analysis/typescript/Types.ts",
    "./src/fuzzer/analysis/typescript",
  ],
  true /* flat */,
  () => console.log("done copying argdef types")
);

// Copy the Oracle types file
copyfiles(
  ["../../src/fuzzer/oracles/Types.ts", "./src/fuzzer/oracles"],
  true /* flat */,
  () => console.log("done copying oracle types")
);
