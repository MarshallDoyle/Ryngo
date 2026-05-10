;; Python query for codegraph tree-sitter indexer.
;;
;; Capture conventions follow research/tree-sitter.md §3:
;;   @def.*        — definitions (function, class, method, variable, type)
;;   @ref.*        — references (call, use, attribute, type-use, decorator, construct)
;;   @import.*     — imports (module, symbol, alias, wildcard, relative)
;;   @name         — the identifier subtree within any of the above
;;   @scope.*      — scope-introducing nodes consumed by the scope walker
;;
;; Whole-construct captures land on the outer node; @name lands on the identifier.
;; The interpreter (python.ts) post-processes function defs whose immediate parent
;; is a class body into methods (per research/tree-sitter.md §3.2 note).

;; ============================================================================
;; Scopes
;; ============================================================================

(module) @scope.module

(class_definition
  body: (block) @scope.class)

(function_definition
  body: (block) @scope.function)

;; ============================================================================
;; Definitions
;; ============================================================================

;; ----- Functions (sync + async). Methods are post-processed from these. -----
(function_definition
  name: (identifier) @name) @def.function

;; ----- Classes -----
(class_definition
  name: (identifier) @name) @def.class

;; ----- Module-level constant assignments: `FOO = ...` -----
(module
  (expression_statement
    (assignment
      left: (identifier) @name))) @def.variable

;; ----- Type aliases: `Foo: TypeAlias = ...` and `type Foo = ...` (PEP 695) -----
(module
  (expression_statement
    (assignment
      left: (identifier) @name
      type: (type) @ref.type))) @def.type

(type_alias_statement
  left: (type
    (identifier) @name)) @def.type

;; ----- Class-body annotated fields: `database_url: str` inside a class body.
;; Used by adapter-env (pydantic-settings) and adapter-fastapi (BaseModel /
;; response_model). The interpreter copies the annotation source text onto
;; ParsedDef.annotation (e.g. "str", "int | None", "Optional[Settings]").
(class_definition
  body: (block
    (expression_statement
      (assignment
        left: (identifier) @name
        type: (type) @def.field.annotation)) @def.field))

;; ----- Subscript reads: `os.environ['X']`, `cfg["DB"]`, `req["body"]`.
;; The interpreter walks `subscript.subscript` for a string literal and
;; surfaces it as `ParsedRef.subscriptKey`. Non-string subscripts (e.g.
;; numeric, variable) leave subscriptKey undefined. -----
(subscript
  value: (_) @ref.receiver
  subscript: (_) @ref.subscript.key) @ref.subscript

;; ----- Decorated definitions: capture the decorator chain. Adapters (FastAPI,
;; pytest, celery) pattern-match these to lift framework conventions. -----
(decorated_definition
  (decorator
    [
      (identifier) @ref.decorator
      (attribute) @ref.decorator
      (call
        function: [
          (identifier) @ref.decorator
          (attribute) @ref.decorator
        ])
    ])
  definition: (_) @def.target) @def.decorated

;; ============================================================================
;; Imports
;; ============================================================================

;; ----- `import foo` and `import foo.bar` -----
(import_statement
  name: (dotted_name) @import.module)

;; ----- `import foo as bar` and `import foo.bar as baz` -----
(import_statement
  name: (aliased_import
    name: (dotted_name) @import.module
    alias: (identifier) @import.alias))

;; ----- `from foo import bar` -----
(import_from_statement
  module_name: (dotted_name) @import.module
  name: (dotted_name) @import.symbol)

;; ----- `from foo import bar as baz` -----
(import_from_statement
  module_name: (dotted_name) @import.module
  name: (aliased_import
    name: (dotted_name) @import.symbol
    alias: (identifier) @import.alias))

;; ----- Relative imports: `from .x import y`, `from ..y import z` -----
;; `relative_import` carries the leading dots; the interpreter counts them.
(import_from_statement
  module_name: (relative_import) @import.relative
  name: (dotted_name) @import.symbol)

(import_from_statement
  module_name: (relative_import) @import.relative
  name: (aliased_import
    name: (dotted_name) @import.symbol
    alias: (identifier) @import.alias))

;; ----- Bare relative: `from . import x` (no module after dots) -----
(import_from_statement
  module_name: (relative_import) @import.relative
  name: (dotted_name) @import.symbol)

;; ----- Wildcard: `from foo import *` — flagged as a diagnostic upstream
;; because resolution gives up (research/tree-sitter.md §4.6). -----
(import_from_statement
  module_name: (dotted_name) @import.module
  (wildcard_import) @import.wildcard)

(import_from_statement
  module_name: (relative_import) @import.relative
  (wildcard_import) @import.wildcard)

;; ============================================================================
;; References
;; ============================================================================

;; ----- Plain calls: `foo(...)`. Receiver-less; resolved via scope first. -----
(call
  function: (identifier) @name) @ref.call

;; ----- Attribute calls: `obj.method(...)` / `pkg.func(...)`.
;; The `(_)` receiver is intentionally generic — could be identifier,
;; attribute chain, subscript, or call result. The resolver walks the
;; receiver tree to pick the right strategy (research/tree-sitter.md §4). -----
(call
  function: (attribute
    object: (_) @ref.receiver
    attribute: (identifier) @name)) @ref.call

;; ----- Attribute access (non-call): `obj.field` -----
(attribute
  object: (_) @ref.receiver
  attribute: (identifier) @name) @ref.attribute

;; ----- Type annotations: function params, return, var-annotated assignment. -----
(typed_parameter
  type: (type
    (identifier) @name)) @ref.type

(typed_default_parameter
  type: (type
    (identifier) @name)) @ref.type

(function_definition
  return_type: (type
    (identifier) @name)) @ref.type

(assignment
  type: (type
    (identifier) @name)) @ref.type

;; ----- Class bases: `class Foo(Bar, mixins.Mixin):` -----
(class_definition
  superclasses: (argument_list
    [
      (identifier) @name
      (attribute
        object: (_) @ref.receiver
        attribute: (identifier) @name)
    ])) @ref.type
