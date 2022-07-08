import { gramSchmidt } from "./gramSchmidt.js";
import * as fs from "fs";
// import data from "./myjsonfile.json" assert {type:"json"};
// import { exportCSVFile } from "./exportCSV.js";

var path = "/Users/sangchoi/numfuzz/src/examples/gramschmidt/myjsonfile.json";
var first = true;
var n = 0;
// function transpose(matrix) {
//     return matrix[0].map((col, i) => matrix.map(row => row[i]));
//   }

// function matprint(mat) {
//     mat = transpose(mat);
//     let shape = [mat.length, mat[0].length];
//     function col(mat, i) {
//         return mat.map(row => row[i]);
//     }
//     let colMaxes = [];
//     for (let i = 0; i < shape[1]; i++) {
//         colMaxes.push(Math.max.apply(null, col(mat, i).map(n => n.toString().length)));
//     }

//     mat.forEach(row => {
//         console.log.apply(null, row.map((val, j) => {
//             return new Array(colMaxes[j]-val.toString().length+1).join(" ") + val.toString() + "  ";
//         }));
//     });
// }

function insReport(id, matrix, output, haserror ,errortype){
    const obj = {id: id, input: matrix, basis: output, HasError: haserror, ErrorType: errortype};
    var json = JSON.stringify(obj);
    if(first){
        fs.appendFileSync(path, json, 'utf8');
        first = false;
    } else {
        fs.appendFileSync(path, '\n,', 'utf8');
        fs.appendFileSync(path, json, 'utf8');
    }
}

function fuzz(iterations, vectorSize, vectorNum){
    for(let i = 0; i < iterations; i++){
        let matrix = [];
        let error = false;
        for(let j =0; j<vectorNum; j++){
            let vector = []
            for(let k=0; k<vectorSize;k++){
                vector[k] = Math.floor(Math.random()*10);
            }
            matrix[j] = vector;
        }
        var output = gramSchmidt(matrix);
        for(let j = 0; j < vectorNum; j++){
            if(!Number.isFinite(output[j][0]) || !Number.isFinite(output[j][1]) || Number.isNaN(output[j][0] || Number.isNaN(output[j][1]))){
                error = true;
            }
        }
        if(error){
            insReport(i, matrix, output, 'True', 'NaN');
        } else {
            insReport(i, matrix, output, 'False', 'NoError');
        }
    }
}
fs.writeFileSync(path, "[\n", 'utf8');

fuzz(1000,2,2);

fs.appendFileSync(path, "\n]", 'utf8');