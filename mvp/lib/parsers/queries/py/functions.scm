;; Python function definitions — top-level `def` and `async def`.
;;
;; Captures:
;;   @function       ─ the function_definition node
;;   @name           ─ identifier name
;;   @params         ─ parameters node (raw `(...)` with type hints)
;;   @return_type    ─ type node after `->`, optional
;;   @body           ─ body block
;;
;; Decorators are siblings of the function_definition in tree-sitter's
;; output, NOT children — the extractor walks decorated_definition
;; explicitly so it can attach the decorator list to the function for
;; future decorator-aware adapters (e.g. FastAPI `@app.get`).
;;
;; Note: this query matches functions at any nesting level. The
;; extractor filters to top-level (Python regex extractor only emits
;; column-0 defs; class methods land via class-body walk in classes.scm)
;; so the IR's def set stays stable across the swap.

(function_definition
  name: (identifier) @name
  parameters: (parameters) @params
  return_type: (_)? @return_type
  body: (block) @body) @function
