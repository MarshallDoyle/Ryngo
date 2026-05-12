;; Go function + method calls.
;;
;; Captures:
;;   @call    ─ the call_expression
;;   @callee  ─ identifier / selector_expression / parenthesized
;;
;; The extractor reduces @callee to a dotted-path string and skips
;; GO_BUILTINS (len, make, append, panic, …) to mirror the regex
;; extractors' behavior in other languages.

(call_expression
  function: (_) @callee) @call
