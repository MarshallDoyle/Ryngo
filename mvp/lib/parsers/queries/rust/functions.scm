;; Rust function declarations.
;;
;; Two contexts:
;;   1. Top-level / impl-scope `function_item`
;;   2. Inside `impl` blocks (same node type, but parent is `declaration_list`
;;      which sits inside `impl_item`).
;;
;; Captures:
;;   @function     ─ function_item node
;;   @name         ─ identifier
;;   @params       ─ parameters (the parenthesized arg list)
;;   @return_type  ─ type, optional
;;
;; Async / unsafe / const / pub modifiers live as siblings of the
;; function_item's named children — we recover them in the extractor
;; by inspecting node.text rather than adding more captures.

(function_item
  name: (identifier) @name
  parameters: (parameters) @params
  return_type: (_)? @return_type
  body: (block)? @body) @function

;; function_signature_item appears inside trait declarations (no body).
(function_signature_item
  name: (identifier) @name
  parameters: (parameters) @params
  return_type: (_)? @return_type) @function
