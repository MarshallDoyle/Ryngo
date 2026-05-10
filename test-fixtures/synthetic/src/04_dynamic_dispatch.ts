// Exercises: function-as-arg dispatch and method-on-typed-interface dispatch.
// Both `invoke` and `processor.handle` should produce indirect call edges
// rather than direct ones — the analyzer cannot statically resolve the target.

type Handler = (input: string) => string;

interface Processor {
  handle(input: string): string;
}

export function invoke(fn: Handler, input: string): string {
  return fn(input);
}

export function dispatch(p: Processor, input: string): string {
  return p.handle(input);
}

const upper: Handler = (s) => s.toUpperCase();

export function run(): string {
  return invoke(upper, "hi");
}
