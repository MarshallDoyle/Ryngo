;; Python call expressions: `foo(...)`, `obj.bar(...)`, `module.fn(...)`.
;;
;; Captures:
;;   @call    ─ the call node
;;   @callee  ─ the function being called (identifier / attribute /
;;              subscript / parenthesized expression)
;;
;; The extractor reduces @callee to a dotted-name string and skips
;; PY_BUILTINS (print, len, range, …) to match the regex extractor.

(call
  function: (_) @callee) @call
