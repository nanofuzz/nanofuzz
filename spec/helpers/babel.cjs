// Transpile TS to JS on load during testing
require("@babel/register")({
  extensions: [".js", ".jsx", ".ts", ".tsx"],
});
