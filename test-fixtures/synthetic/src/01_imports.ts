// Exercises: named import, default import, namespace import, re-export, barrel.
// Companion module is `./_helpers` (also in this fixture).

import { add, sub } from "./_helpers";
import defaultLogger from "./_helpers";
import * as helpers from "./_helpers";

export { add, sub } from "./_helpers";
export * from "./_helpers";

export function compute(a: number, b: number): number {
  defaultLogger.log("compute");
  return helpers.mul(add(a, b), sub(a, b));
}
