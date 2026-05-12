;; Go import declarations.
;;
;; Two shapes:
;;   import "fmt"                                  single
;;   import ( "fmt" ; mux "github.com/gorilla/mux" )  grouped
;;
;; tree-sitter-go expresses both via `import_spec` children of either
;; `import_declaration` (single) or `import_spec_list` (grouped). We
;; capture each spec independently and let the extractor build one
;; binding per package.

(import_spec
  name: (_)? @alias
  path: (interpreted_string_literal) @path) @import_spec
