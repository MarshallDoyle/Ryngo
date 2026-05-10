;; ============================================================================
;; Tree-sitter queries for TypeScript / JavaScript (and TSX/JSX).
;;
;; Capture-name vocabulary follows `research/tree-sitter.md` §3:
;;
;;   @def.function       function / arrow / function-expression declarations
;;   @def.class          class declarations and class expressions
;;   @def.method         methods inside class_body
;;   @def.variable       const/let/var declarations binding non-callable values
;;   @def.type           interfaces, type aliases, enums (TS only — graceful
;;                       no-op against the JS grammar, since the patterns
;;                       reference TS-only node kinds and just don't match)
;;   @def.reexport       `export { foo } from "..."`
;;
;;   @ref.call           call sites
;;   @ref.identifier     bare-identifier uses (read references)
;;   @ref.attribute      member-expression access (non-call)
;;   @ref.type           type annotations / type references
;;   @ref.construct      `new Foo(...)` — disambiguated from plain calls
;;
;;   @import.module      module specifier in `from "..."`
;;   @import.symbol      named-import source name
;;   @import.alias       local alias for an aliased import
;;   @import.default     local binding for a default import
;;   @import.namespace   local binding for `import * as ns`
;;   @import.dynamic     module specifier in `import("...")`
;;   @import.require     module specifier in `require("...")`
;;
;;   @scope.module       file root
;;   @scope.class        class body
;;   @scope.function     function / method / arrow body
;;   @scope.block        statement block
;;
;;   @name               the identifier subtree within any of the above
;;
;; The runtime concatenates this single file (we keep defs+refs+imports
;; together rather than three separate `.scm` files because tree-sitter's
;; query engine amortises better with one query per parse and we lose
;; nothing readability-wise).
;;
;; Authoring conventions (research/tree-sitter.md §3.4):
;;   - one concept per pattern
;;   - @name lands on the smallest identifier
;;   - whole-construct capture comes last so consumers can walk back to body
;;   - no #match? / #eq? predicates here; lexical filtering happens in
;;     resolver.ts where it doesn't defeat caching.
;; ============================================================================


;; ============================================================================
;; SCOPES — drive the lexical-scope walker (§4.1)
;; ============================================================================

(program) @scope.module

(class_body) @scope.class

(function_declaration body: (statement_block) @scope.function)
(function_expression body: (statement_block) @scope.function)
(arrow_function body: (statement_block) @scope.function)
(arrow_function body: (_) @scope.function)
(method_definition body: (statement_block) @scope.function)

(statement_block) @scope.block


;; ============================================================================
;; DEFINITIONS — functions, classes, methods, types
;; ============================================================================

;; ---- Function declarations ------------------------------------------------
(function_declaration
  name: (identifier) @name
) @def.function

(generator_function_declaration
  name: (identifier) @name
) @def.function

;; ---- `const foo = () => {}` and `const foo = function () {}` --------------
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)]
  )
) @def.function

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)]
  )
) @def.function

;; ---- Plain (non-callable) const/let/var bindings --------------------------
;; These come last so the function-shaped patterns above win on the same node
;; in document order; the runtime de-duplicates by (range, capture).
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
  )
) @def.variable

(variable_declaration
  (variable_declarator
    name: (identifier) @name
  )
) @def.variable

;; ---- Class declarations and class expressions assigned to a name ----------
(class_declaration
  name: (type_identifier) @name
) @def.class

(class_declaration
  name: (identifier) @name
) @def.class

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (class) @def.class
  )
)

;; ---- Methods inside class bodies ------------------------------------------
(class_body
  (method_definition
    name: (property_identifier) @name
  ) @def.method
)

;; Constructors are method_definition with name "constructor"; the consumer
;; promotes them to @def.method with kind: "ctor". TypeScript adds
;; abstract / public / private / protected modifiers — those are sibling
;; nodes the grammar exposes as accessibility_modifier; we don't bind them
;; here.

;; ---- Object-literal methods (`module.exports = { foo() {} }`) ------------
(pair
  key: (property_identifier) @name
  value: [(arrow_function) (function_expression)]
) @def.function

;; Shorthand method syntax in object literals.
(method_definition
  name: (property_identifier) @name
) @def.function

;; ---- TypeScript type-system definitions -----------------------------------
(interface_declaration
  name: (type_identifier) @name
) @def.type

(type_alias_declaration
  name: (type_identifier) @name
) @def.type

(enum_declaration
  name: (identifier) @name
) @def.type

;; ---- Re-exports: `export { foo } from "./bar"` ----------------------------
(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @name
    )
  )
  source: (string) @import.module
) @def.reexport


;; ============================================================================
;; REFERENCES — calls, identifier uses, attribute access, type uses
;; ============================================================================

;; ---- Plain calls: `foo(args)` ---------------------------------------------
(call_expression
  function: (identifier) @name
) @ref.call

;; ---- Member calls: `obj.method(args)` or `pkg.fn(args)` -------------------
;; The receiver is captured generically (`(_)`) so the resolver can inspect
;; identifier vs nested member vs indexed-access etc. (research §3.3 pattern).
(call_expression
  function: (member_expression
    object: (_) @ref.receiver
    property: (property_identifier) @name
  )
) @ref.call

;; ---- Constructor calls: `new Foo(args)` -----------------------------------
;; Disambiguated so adapters that draw class-instantiation graphs can isolate
;; these (research §4.5 "constructor / class-call disambiguation").
(new_expression
  constructor: (identifier) @name
) @ref.construct

(new_expression
  constructor: (member_expression
    object: (_) @ref.receiver
    property: (property_identifier) @name
  )
) @ref.construct

;; ---- Plain attribute / member access (non-call): `obj.field` --------------
(member_expression
  object: (_) @ref.receiver
  property: (property_identifier) @name
) @ref.attribute

;; ---- Subscript / index access: `obj['KEY']`, `obj["KEY"]` ----------------
;; Captures the literal key as @ref.subscript-key so adapter-env can spot
;; `process.env['DATABASE_URL']` and similar without re-walking the AST.
;; Coordinated with py-indexer's `os.environ['X']` capture.
(subscript_expression
  object: (_) @ref.receiver
  index: (string) @ref.subscript-key
) @ref.subscript

;; ============================================================================
;; CLASS-BODY FIELDS — annotated property declarations
;; ============================================================================

;; `class Foo { x: string; y = 0 }` — captured as @def.field with the
;; annotation surfaced via the runtime's `extractFieldAnnotation` walk
;; (we don't try to capture the annotation as a separate scheme node
;; because tree-sitter type_annotation needs trimming the leading `:`).
(class_body
  (public_field_definition
    name: (property_identifier) @name
  ) @def.field
)

;; ---- Type-position references (TS) ----------------------------------------
;; `(x: Foo)`, `function f(): Bar`, `type X = Foo<Bar>`.
(type_identifier) @ref.type

(type_annotation
  (type_identifier) @name
) @ref.type

(generic_type
  name: (type_identifier) @name
) @ref.type


;; ============================================================================
;; IMPORTS — module / named / default / namespace / dynamic / require
;; ============================================================================

;; ---- `import { foo, bar as baz } from "mod"` ------------------------------
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @import.symbol
      )
    )
  )
  source: (string) @import.module
)

(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @import.symbol
        alias: (identifier) @import.alias
      )
    )
  )
  source: (string) @import.module
)

;; ---- `import foo from "mod"` ----------------------------------------------
(import_statement
  (import_clause
    (identifier) @import.default
  )
  source: (string) @import.module
)

;; ---- `import * as ns from "mod"` ------------------------------------------
(import_statement
  (import_clause
    (namespace_import
      (identifier) @import.namespace
    )
  )
  source: (string) @import.module
)

;; ---- `import "mod"` (side-effect only) -----------------------------------
(import_statement
  source: (string) @import.module
) @import.side-effect

;; ---- Dynamic import: `import("mod")` --------------------------------------
(call_expression
  function: (import)
  arguments: (arguments (string) @import.dynamic)
)

;; ---- CommonJS: `const x = require("mod")` ---------------------------------
;; Captured here so the resolver can fold these into the import map alongside
;; ESM. Patterns like `require.resolve(...)` are intentionally not captured.
(call_expression
  function: (identifier) @_require_fn
  arguments: (arguments (string) @import.require)
  (#eq? @_require_fn "require")
)
