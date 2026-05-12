;; Python class definitions.
;;
;; Captures:
;;   @class       ─ class_definition node
;;   @name        ─ identifier
;;   @bases       ─ argument_list node containing base classes, optional
;;   @body        ─ body block (used to enumerate methods + fields via JS)
;;
;; Per-method walk happens in py-tree-sitter.js by iterating the
;; class body — tree-sitter-python distinguishes function_definition
;; from method names by context, but it's simpler to text-extract
;; the body and reuse the regex extractor's `extractClassMembers`
;; helper for parity.

(class_definition
  name: (identifier) @name
  superclasses: (argument_list)? @bases
  body: (block) @body) @class
