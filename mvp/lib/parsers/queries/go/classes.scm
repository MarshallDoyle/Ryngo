;; Go type declarations: structs, interfaces, type aliases.
;; We treat each as a "class" in the IR so the viewer renders them
;; uniformly with other languages.
;;
;; Captures:
;;   @class       ─ type_declaration (one declaration can contain
;;                  multiple type_spec children — extractor walks them)
;;   @class_spec  ─ a single type_spec node
;;   @name        ─ identifier
;;   @body        ─ struct_type / interface_type / type alias body
;;
;; Method bodies are NOT in the class body — Go puts methods at the
;; top level. So `members.methods` is built by the extractor walking
;; method_declaration nodes and grouping them by receiver type.

(type_declaration
  (type_spec
    name: (type_identifier) @name
    type: (_) @body) @class_spec) @class
