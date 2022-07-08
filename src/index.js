import { smartTable } from "smart-table-core";
import { SortDirection } from "smart-table-sort";

// your data
const data = [
  { input: [0,0], output: [NaN,3] },
  { input: [1,1], output: [3, NaN]},
  { input: [2,2], output: [5,Infinity] },
  { input: [3,3], output: [Infinity, 5] },
  { input: [4,4], output: [NaN,NaN] },
  { input: [6,6], output: [Infinity,Infinity]},
  { input: [8,8], output: [10,10]},
];
//you have now a smart collection !
const smartCollection = smartTable({ data });

//print data anytime the state change
smartCollection.onDisplayChange((items) => {
  console.log(items.map((item) => item.value));
});

//sort for example
smartCollection.sort({ pointer: "output", direction: SortDirection.DESC });
// > the sorted data should be printed in the console.

export {};
