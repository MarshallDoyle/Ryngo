;; Class declarations + members. The class anchor (@class) captures
;; the whole declaration so the extractor can compute the class's
;; line range; per-method captures live at a different match index
;; so the extractor can attach them to the class as `members.methods`.
;;
;; Captures:
;;   @class               ─ class_declaration node
;;   @class_name          ─ identifier name of the class
;;   @class_body          ─ class_body node (used to enumerate members)
;;   @class_heritage      ─ optional `extends X` clause
;;   @interface           ─ interface_declaration node
;;   @interface_name      ─ identifier name of the interface
;;   @enum                ─ enum_declaration node
;;   @enum_name           ─ identifier
;;   @type_alias          ─ type_alias_declaration node
;;   @type_alias_name     ─ identifier
;;
;; Method + field extraction happens by walking @class_body in JS;
;; tree-sitter-typescript exposes method_definition + field types
;; reliably enough that a simple loop is easier than another query.

(class_declaration
  name: (type_identifier) @class_name
  (class_heritage)? @class_heritage
  body: (class_body) @class_body) @class

(interface_declaration
  name: (type_identifier) @interface_name
  body: (interface_body)) @interface

(enum_declaration
  name: (identifier) @enum_name
  body: (enum_body)) @enum

(type_alias_declaration
  name: (type_identifier) @type_alias_name) @type_alias
