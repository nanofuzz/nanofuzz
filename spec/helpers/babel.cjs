// Transpile TS to JS on load during testing
require("@babel/register")({
  extensions: [".js", ".jsx", ".ts", ".tsx"],
  ignore: [/node_modules/],
});

if (typeof jasmine !== "undefined") {
  jasmine.DEFAULT_TIMEOUT_INTERVAL = 180000;
}
