;; Rust `use` declarations.
;;
;; Captures:
;;   @use         ─ the use_declaration node
;;
;; The extractor parses use_declaration.text to get the path + bindings:
;;   use std::collections::HashMap;       → spec "std::collections", bindings { HashMap: "HashMap" }
;;   use std::io::{self, Read, Write};    → spec "std::io",          bindings { self/Read/Write }
;;   use crate::foo::Bar as Baz;          → spec "crate::foo",       bindings { Baz: "Bar" }
;;   use serde_json::Value;               → spec "serde_json",       bindings { Value: "Value" }

(use_declaration) @use

(extern_crate_declaration
  name: (identifier) @crate_name) @extern_crate
