const copyfiles = require("copyfiles");
const rimraf = require("rimraf");

// Clean the build folder
rimraf.sync("./build");

// Copy the license file
copyfiles(["../../../LICENSE", "."], true /* flat */, () =>
  console.log("done copying license file")
);
