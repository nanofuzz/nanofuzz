const subpackageVersion = require("./package.json").version.split("-")[0];
const packageVersion = require("../../package.json").version.split("-")[0];

// Return an error if the versions are different
//
// Note: Only considers the major, minor, and patch versions
if (subpackageVersion === packageVersion) {
  console.info("Package versions match");
  process.exit(0);
} else {
  console.error(
    `ERROR: Package versions are not the same! \r\n   Package: ${packageVersion} \r\nSubpackage: ${subpackageVersion}`
  );
  process.exit(1);
}
