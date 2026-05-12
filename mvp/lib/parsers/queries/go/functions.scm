;; Go function + method declarations.
;;
;; Captures:
;;   @function     ─ either function_declaration or method_declaration
;;   @name         ─ identifier
;;   @params       ─ parameter_list (the inner contents become the
;;                   ParsedFile param records)
;;   @return_type  ─ optional — a single type, parameter_list (for
;;                   multi-return), or pointer_type. Whatever it is,
;;                   we copy the text verbatim into returnType.display.
;;   @receiver     ─ optional, only on method_declaration. Lets the
;;                   extractor compute the qualified method name
;;                   "Receiver.MethodName" so methods don't clash with
;;                   free functions of the same name.

(function_declaration
  name: (identifier) @name
  parameters: (parameter_list) @params
  result: (_)? @return_type) @function

(method_declaration
  receiver: (parameter_list) @receiver
  name: (field_identifier) @name
  parameters: (parameter_list) @params
  result: (_)? @return_type) @function
