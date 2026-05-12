;; ES module imports — `import X from 'pkg'`, `import * as Y from '...'`,
;; `import { a, b as c } from './local'`, `import 'side-effect'`.
;;
;; Captures:
;;   @import         ─ the entire import_statement
;;   @source         ─ the string literal source path
;;
;; The extractor parses @import.text further when it needs the
;; bindings list — the import_clause sub-structure is too varied to
;; usefully query in one .scm pattern.

(import_statement
  source: (string) @source) @import
