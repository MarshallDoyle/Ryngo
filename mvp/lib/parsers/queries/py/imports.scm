;; Python imports:
;;   import foo
;;   import foo.bar as baz
;;   import foo, bar.baz
;;   from foo import bar, baz as alias
;;   from .local import thing
;;   from ..parent import other
;;
;; Captures:
;;   @import          ─ the whole import_statement or import_from_statement
;;
;; The extractor parses the @import.text further to pull out spec +
;; bindings + isRelative — matching what the regex extractor does.
;; A single .scm pattern can't expand the alternation into a flat
;; binding list, and trying gets messy. Text-parse is simpler and
;; bug-for-bug equal.

(import_statement) @import
(import_from_statement) @import
