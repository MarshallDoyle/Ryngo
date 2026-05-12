;; Call expressions — `foo(...)`, `obj.bar(...)`, `obj?.baz(...)`.
;;
;; Captures:
;;   @call          ─ the call_expression
;;   @callee        ─ the function expression being called (identifier,
;;                    member_expression, optional_chain, …). The
;;                    extractor figures out the actual name from this.
;;
;; new-expressions are captured separately so the extractor can mark
;; them as constructor calls (treated the same as a regular call for
;; the purpose of `calls` edges).

(call_expression
  function: (_) @callee) @call

(new_expression
  constructor: (_) @callee) @call
