// Companion module for 01_imports.ts. Exists so the import IR has real targets.

export function add(a: number, b: number): number {
  return a + b;
}

export function sub(a: number, b: number): number {
  return a - b;
}

export function mul(a: number, b: number): number {
  return a * b;
}

const logger = {
  log(msg: string): void {
    console.log(msg);
  },
};

export default logger;
