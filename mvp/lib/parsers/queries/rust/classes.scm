;; Rust types: structs, enums, traits, type aliases. All rendered as
;; "class" in the IR for visual uniformity.
;;
;; Captures (one of the patterns matches per declaration):
;;   @class                ─ the declaration node
;;   @name                 ─ identifier
;;   @body                 ─ field_declaration_list / enum_variant_list /
;;                           declaration_list (for traits), optional

(struct_item
  name: (type_identifier) @name
  body: (_)? @body) @class

(enum_item
  name: (type_identifier) @name
  body: (enum_variant_list)? @body) @class

(trait_item
  name: (type_identifier) @name
  body: (declaration_list)? @body) @class

(type_item
  name: (type_identifier) @name) @class

(union_item
  name: (type_identifier) @name
  body: (_)? @body) @class
