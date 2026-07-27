/* eslint-disable @typescript-eslint/no-unused-vars */
import * as more12 from "./imports2";
import myDefault from "./imports";

type xz = {
  x: number;
  z: 1;
};

export function test1(x: myDefault): myDefault {
  return x;
}

// export function test2(x: number, z: more12.FuzzIoElement) {
//   return { in: [], out: undefined, exception: false, timeout: false };
// }

// export function test3(x: myDefault, y: xz): xz {
//   return { x: 5, z: 1 };
// }

// export function test4(x: myDefault): { x: number; y: { z: string } } {
//   return { x: 5, y: { z: "yo" } };
// }

// export function test5(x: myDefault): { x: number | string; y: { z: string } } {
//   return { x: 5, y: { z: "yo" } };
// }
