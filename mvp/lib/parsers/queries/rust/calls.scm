;; Rust function + method calls + struct construction.
;;
;; `call_expression`     ─ foo(...), obj.method(...)
;; `macro_invocation`    ─ println!(...), vec![...] — emit as calls too
;;                         so the IR shows macro usage edges.

(call_expression
  function: (_) @callee) @call

(macro_invocation
  macro: (_) @callee) @call
