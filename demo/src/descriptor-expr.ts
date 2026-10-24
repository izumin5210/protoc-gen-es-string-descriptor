import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { base64Decode } from "@bufbuild/protobuf/wire";
import {
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
} from "@bufbuild/protobuf/wkt";
import type { DescriptorFormat } from "./generate.js";
import {
  PUBLIC_DEPENDENCY,
  peekMarkers,
  restoreInlineNames,
  WEAK_DEPENDENCY,
} from "./names/inline.js";
import { type NameEntry, restoreNames } from "./names/table.js";
import { type DescTree, fromTree } from "./option-b/runtime.js";

/**
 * Cut the `fileDesc(...)` call out of a generated file. String literals never
 * contain a raw line break, so the first `);` at the end of a line closes it.
 */
export function extractDescriptorExpr(content: string): string {
  const start = content.indexOf("fileDesc(");
  if (start < 0) {
    throw new Error("no fileDesc call found");
  }
  const end = content.indexOf(");\n", start);
  if (end < 0) {
    throw new Error("unterminated fileDesc call");
  }
  return content.slice(start, end + 2);
}

/**
 * Decode the first argument of a `fileDesc(...)` call back to descriptor
 * bytes without evaluating it. Throws on anything that is not a well-formed
 * literal, e.g. a merge result with conflict markers.
 */
export function decodeDescriptorExpr(
  expr: string,
  encoding: DescriptorFormat,
): Uint8Array {
  const { arg, imports, names } = parseFileDescCall(expr, encoding);
  if (typeof arg !== "string") {
    const bytes = fromTree(arg);
    if (encoding === "b") {
      return bytes;
    }
    const file = fromBinary(FileDescriptorProtoSchema, bytes);
    if (encoding === "names") {
      file.dependency = importNames(file, imports);
      restoreInlineNames(file);
      file.dependency = [];
    } else {
      restoreNames(file, names, imports);
    }
    return toBinary(FileDescriptorProtoSchema, file);
  }
  if (encoding === "base64") {
    return base64Decode(arg);
  }
  const bytes = new Uint8Array(arg.length);
  for (let i = 0; i < arg.length; i++) {
    bytes[i] = arg.charCodeAt(i);
  }
  return bytes;
}

/**
 * `dependency` as the runtime would set it from the imports, as far as the
 * import markers need it. Without evaluating the code, only the identifiers
 * are known; protoc-gen-es names the export of `a/b.proto` `file_a_b`.
 */
function importNames(file: FileDescriptorProto, imports: string[]): string[] {
  const byIdentifier = new Map(
    [PUBLIC_DEPENDENCY, WEAK_DEPENDENCY]
      .flatMap((no) => peekMarkers(file, no))
      .map((name) => [
        `file_${name.replace(/\.proto$/, "").replace(/[^a-zA-Z0-9_]+/g, "_")}`,
        name,
      ]),
  );
  return imports.map((id) => byIdentifier.get(id) ?? id);
}

/** The first argument of a `fileDesc(...)` call as the runtime receives it. */
export function parseDescriptorArg(
  expr: string,
  encoding: DescriptorFormat,
): string | DescTree {
  return parseFileDescCall(expr, encoding).arg;
}

/**
 * All arguments of a `fileDesc(descriptor, imports, names)` call, with
 * imports as identifiers.
 */
export function parseFileDescCall(
  expr: string,
  encoding: DescriptorFormat,
): {
  arg: string | DescTree;
  imports: string[];
  names: NameEntry<string>[];
} {
  const parser = new Parser(tokenize(expr));
  parser.expect("ident", "fileDesc");
  parser.expect("(");
  let arg: string | DescTree;
  if (encoding === "base64" || encoding === "a") {
    arg = parser.string();
    while (parser.optional("+")) {
      arg += parser.string();
    }
  } else {
    arg = parser.tree();
  }
  const imports: string[] = [];
  const names: NameEntry<string>[] = [];
  if (parser.optional(",")) {
    parser.list(() => imports.push(parser.ident()));
  }
  if (parser.optional(",")) {
    parser.list(() => {
      parser.expect("[");
      const kind = parser.string();
      parser.expect(",");
      if (kind === "oneof") {
        const member = parser.string();
        parser.expect(",");
        names.push([kind, member, parser.string()]);
      } else if (kind === "public" || kind === "weak") {
        names.push([kind, parser.ident()]);
      } else {
        throw new Error(`unknown name entry ${kind}`);
      }
      parser.expect("]");
    });
  }
  parser.expect(")");
  return { arg, imports, names };
}

type Token =
  | { kind: "string"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "[" | "]" | "(" | ")" | "," | "+" | ";"; value?: undefined };

const SIMPLE_ESCAPES: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "0": "\0",
  '"': '"',
  "'": "'",
  "\\": "\\",
};

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (src.startsWith("//", i)) {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
    } else if ("[]()+,;".includes(c)) {
      tokens.push({ kind: c as "[" });
      i++;
    } else if (c === '"') {
      let value = "";
      i++;
      while (src[i] !== '"') {
        if (i >= src.length || src[i] === "\n") {
          throw new Error("unterminated string literal");
        }
        if (src[i] !== "\\") {
          value += src[i++];
          continue;
        }
        const e = src[i + 1];
        if (e === "x") {
          value += String.fromCharCode(parseHex(src.slice(i + 2, i + 4)));
          i += 4;
        } else if (e === "u") {
          value += String.fromCharCode(parseHex(src.slice(i + 2, i + 6)));
          i += 6;
        } else if (e in SIMPLE_ESCAPES) {
          value += SIMPLE_ESCAPES[e];
          i += 2;
        } else {
          throw new Error(`unsupported escape \\${e}`);
        }
      }
      i++;
      tokens.push({ kind: "string", value });
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
      if (!m) {
        throw new Error(`unexpected character ${JSON.stringify(c)}`);
      }
      tokens.push({ kind: "ident", value: m[0] });
      i += m[0].length;
    }
  }
  return tokens;
}

function parseHex(hex: string): number {
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`invalid hex escape ${hex}`);
  }
  return Number.parseInt(hex, 16);
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos++];
    if (token === undefined) {
      throw new Error("unexpected end of input");
    }
    return token;
  }

  expect(kind: Token["kind"], value?: string): void {
    const token = this.next();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? kind}, got ${token.kind}`);
    }
  }

  optional(kind: Token["kind"]): boolean {
    if (this.peek()?.kind !== kind) {
      return false;
    }
    this.next();
    return true;
  }

  ident(): string {
    const token = this.next();
    if (token.kind !== "ident") {
      throw new Error(`expected identifier, got ${token.kind}`);
    }
    return token.value;
  }

  /** `[item, item, ]`, calling `item` for each element. */
  list(item: () => void): void {
    this.expect("[");
    while (this.peek()?.kind !== "]") {
      item();
      this.optional(",");
    }
    this.expect("]");
  }

  string(): string {
    const token = this.next();
    if (token.kind !== "string") {
      throw new Error(`expected string, got ${token.kind}`);
    }
    return token.value;
  }

  tree(): DescTree {
    const items: (string | [string, DescTree])[] = [];
    this.expect("[");
    while (this.peek()?.kind !== "]") {
      if (this.peek()?.kind === "[") {
        this.next();
        const tag = this.string();
        this.expect(",");
        items.push([tag, this.tree()]);
        this.expect("]");
      } else {
        items.push(this.string());
      }
      if (this.peek()?.kind === ",") {
        this.next();
      }
    }
    this.expect("]");
    return items;
  }
}
