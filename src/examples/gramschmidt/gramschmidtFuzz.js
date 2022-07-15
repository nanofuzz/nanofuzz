import { gramSchmidt } from "./gramSchmidt.js";
import * as fs from "fs";
// import data from "./myjsonfile.json" assert {type:"json"};
import { exportCSVFile } from "./exportCSV.js";

function transpose(matrix) {
  return matrix[0].map((col, i) => matrix.map((row) => row[i]));
}

function matprint(mat) {
  mat = transpose(mat);
  let shape = [mat.length, mat[0].length];
  function col(mat, i) {
    return mat.map((row) => row[i]);
  }
  let colMaxes = [];
  for (let i = 0; i < shape[1]; i++) {
    colMaxes.push(
      Math.max.apply(
        null,
        col(mat, i).map((n) => n.toString().length)
      )
    );
  }

  mat.forEach((row) => {
    console.log.apply(
      null,
      row.map((val, j) => {
        return (
          new Array(colMaxes[j] - val.toString().length + 1).join(" ") +
          val.toString() +
          "  "
        );
      })
    );
  });
}

function insReport(matrix, output) {
  var obj = { input: matrix, basis: output };
  var json = JSON.stringify(obj, null, 2);
  fs.appendFileSync("myjsonfile.json", json, "utf8");
}

const writeFile = "outputVal.txt";
function fuzz(iterations, vectorSize, vectorNum) {
  let passedVals = [];
  let passedValsInput = [];
  let passedValsCount = 0;
  var first = true;
  let ok = 0;
  for (let i = 0; i < iterations; i++) {
    let matrix = [];
    for (let j = 0; j < vectorNum; j++) {
      let vector = [];
      for (let k = 0; k < vectorSize; k++) {
        vector[k] = Math.floor(Math.random() * 10);
      }
      matrix[j] = vector;
    }

    var output = gramSchmidt(matrix);
    var error = false;
    for (let j = 0; j < vectorNum; j++) {
      if (!error) {
        if (
          !Number.isFinite(output[j][0]) ||
          !Number.isFinite(output[j][1]) ||
          Number.isNaN(output[j][0] || Number.isNaN(output[j][1]))
        ) {
          console.error(
            `Error after ${ok} non-errors: ${JSON.stringify([matrix, output])}`
          );
          ok = 0;
          error = true;
          if (first) {
            insReport(matrix, output);
            first = false;
          } else {
            fs.appendFileSync("myjsonfile.json", ",", "utf8");
            insReport(matrix, output);
          }
        }
      }
    }
    if (!error) {
      console.log(`Ok# ${++ok}: ${JSON.stringify([matrix, output])}`);
    }
  }
  // if(passedVals.length !== 0){
  //         for(var i = 0; i < passedVals.length; i++){
  //             console.log("input");
  //             matprint(passedValsInput[i]);
  //             console.log("output");
  //             matprint(passedVals[i]);
  //             console.log();
  //         }

  // }
}
console.log("GRAM-Schmidt report");
console.log("Failed values");
console.log();

fs.writeFileSync("myjsonfile.json", "[\n", "utf8");

fuzz(1000000, 2, 2);

fs.appendFileSync("myjsonfile.json", "\n]", "utf8");
