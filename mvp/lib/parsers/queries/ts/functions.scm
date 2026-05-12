;; Function declarations Ryngo emits as `def:` nodes.
;;
;; Captures per pattern:
;;   @function            ─ the whole declaration node
;;   @name                ─ the identifier (used as the def's `name`)
;;   @params              ─ the formal_parameters node (later parsed
;;                          to extract per-param name + type)
;;   @return_type         ─ optional type_annotation
;;   @body                ─ statement_block / expression body
;;   @async               ─ optional `async` keyword (presence = async fn)
;;
;; Patterns cover:
;;   1. `function foo(...): T { ... }`
;;   2. `async function foo(...): Promise<T> { ... }`
;;   3. `const foo = (...): T => { ... }`           arrow
;;   4. `const foo = async (...): T => ...`         async arrow
;;   5. `const foo = function (...): T { ... }`     fn expression
;;   6. `export default function foo(...) { ... }`
;;
;; Methods and class fields live in classes.scm — those need a class
;; anchor capture so the extractor can attach them to the right parent.

;; 1 / 2  — top-level function declarations (sync + async)
(function_declaration
  name: (identifier) @name
  parameters: (formal_parameters) @params
  return_type: (type_annotation)? @return_type
  body: (statement_block) @body) @function

;; 3 / 4 — const-assigned arrow / function expressions
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: [
      (arrow_function
        parameters: (formal_parameters) @params
        return_type: (type_annotation)? @return_type
        body: _ @body) @function
      (function_expression
        parameters: (formal_parameters) @params
        return_type: (type_annotation)? @return_type
        body: _ @body) @function
    ]))

;; 3 / 4 — let / var variants
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [
      (arrow_function
        parameters: (formal_parameters) @params
        return_type: (type_annotation)? @return_type
        body: _ @body) @function
      (function_expression
        parameters: (formal_parameters) @params
        return_type: (type_annotation)? @return_type
        body: _ @body) @function
    ]))
