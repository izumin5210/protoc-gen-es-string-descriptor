// Markers that say by name what the descriptor would otherwise say by
// position. They are length-delimited unknown fields with the largest field
// numbers, whose payload is a UTF-8 name. FieldDescriptorProto and
// FileDescriptorProto declare no extension ranges, so these numbers never
// carry real data.

/** On a field: the name of its real oneof, instead of `oneof_index`. */
export const ONEOF = 536870911;
/** On the file: a public import's file name, instead of `public_dependency`. */
export const PUBLIC_DEPENDENCY = 536870910;
/** On the file: a weak import's file name, instead of `weak_dependency`. */
export const WEAK_DEPENDENCY = 536870909;
