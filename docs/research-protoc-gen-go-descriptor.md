# protoc-gen-go の File Descriptor 分割アルゴリズム調査

## 背景

[CL 657895](https://go-review.googlesource.com/c/protobuf/+/657895) (`internal_gengo: generate a const string literal for the raw descriptor`) は 2025年3月20日にマージされた。

従来の protoc-gen-go では、シリアライズされた `FileDescriptorProto` を固定16バイトごとに区切った hex byte slice として生成していた。この方式では、proto ファイルの先頭付近を1バイトでも変更すると、以降の全行がずれて diff が発生し、コンフリクトが頻発する問題があった。

## アルゴリズム

### Step 1: FileDescriptorProto のシリアライズ

```go
descProto := proto.Clone(f.Proto).(*descriptorpb.FileDescriptorProto)
descProto.SourceCodeInfo = nil
stripSourceRetentionFieldsFromMessage(descProto.ProtoReflect())
b, err := proto.MarshalOptions{AllowPartial: true, Deterministic: true}.Marshal(descProto)
```

- FileDescriptorProto をクローン
- SourceCodeInfo を除去
- source-retention-only フィールドを除去
- 決定論的にシリアライズ

### Step 2: `0x0a` バイト境界で分割

```go
fmt.Fprint(g, "const ", rawDescVarName(f), ` = ""`)
for _, line := range bytes.SplitAfter(b, []byte{'\x0a'}) {
    g.P("+")
    fmt.Fprintf(g, "%q", line)
}
```

**`bytes.SplitAfter(b, []byte{'\x0a'})`** がコアのロジック。

### なぜ `0x0a` なのか

protobuf の wire format では、フィールドタグは `(field_number << 3) | wire_type` でエンコードされる。

- field_number=1, wire_type=2 (LEN: 文字列、バイト列、埋め込みメッセージ) の場合:
  - `(1 << 3) | 2 = 8 | 2 = 10 = 0x0a`

`FileDescriptorProto` およびそのサブメッセージ（`DescriptorProto`, `EnumDescriptorProto`, `FieldDescriptorProto`, `ServiceDescriptorProto` など）は多くが `string name = 1;` フィールドを持つ。そのため、これらのメッセージは wire format で `0x0a` から始まる。

`0x0a` で分割することで、各「行」が proto ファイル内の論理的なメッセージ/フィールド/enum/サービス定義にほぼ対応するチャンクになる。

CL のコミットメッセージより:
> "We use the fact that FileDescriptorProto (and some submessages) have a LEN encoded field (string) with field_number=1, so splitting at 0x0a (incidentally a newline character in ascii) we get a splitting that almost looks readable."

### Step 3: `%q` フォーマット

各チャンクは Go の `%q` verb でフォーマットされる。非印字文字や非UTF-8バイトは適切にエスケープされる（`\x0a`, `\x12`, `\n` など）。

## 出力形式の比較

### Before (旧形式: hex byte slice, 16バイト固定チャンク)

```go
var file_nested_messages_proto_rawDesc = string([]byte{
    0x0a, 0x37, 0x63, 0x6d, 0x64, 0x2f, 0x70, 0x72, 0x6f, 0x74, 0x6f, 0x63, 0x2e, 0x67, 0x65, 0x6e,
    0x2d, 0x67, 0x6f, 0x2f, 0x74, 0x65, 0x73, 0x74, 0x64, 0x61, 0x74, 0x61, 0x2f, 0x70, 0x72, 0x6f,
    // ... 16バイトごとに改行
})
```

### After (新形式: const string literal, `0x0a` 境界で分割)

```go
const file_proto_rawDesc = "" +
    "\n" +
    "7cmd/protoc-gen-go/testdata/proto2/nested_messages.proto\x12\x15goproto.protoc.proto2\\" +
    "\xcc\x01\n" +
    "\x06Layer1\x124\n" +
    "\x02l2\x18\x01 \x01(\v2$.goproto.protoc.proto2.Layer1.Layer2R\x02l2\x12;\n" +
    "\x02l3\x18\x02 \x01(\v2+.goproto.protoc.proto2.Layer1.Layer2.Layer3R\x02l3\x1aO\n" +
    "\x06Layer2\x12;\n" +
    // ...
```

## Diff フレンドリーな理由

| 変更内容 | 旧形式 | 新形式 |
|----------|--------|--------|
| フィールド追加 | 挿入点以降の全行が変化 | 該当メッセージの行のみ変化 |
| フィールド名変更 | 変更点以降の全行が変化 | 該当フィールドの行のみ変化 |
| メッセージ追加 | 挿入点以降の全行が変化 | 新しい行が挿入されるのみ |

旧形式はポジションベースの分割のため、先頭の変更が全体に波及する。新形式はコンテンツベースの分割のため、変更が局所化される。

## 本プロジェクトへの適用

protoc-gen-es では `fileDesc("base64string")` の形式で base64 エンコードされた FileDescriptorProto が1行の文字列として出力される。このbase64文字列を:

1. base64 デコードして生バイト列を得る
2. `0x0a` バイトで `splitAfter` する
3. 各チャンクを JavaScript の文字列リテラルとしてエスケープする
4. 複数行の文字列連結形式で出力する

という変換を行い、diff フレンドリーな出力に変換する。

## エンコード形式の選択肢

Go の `%q` は Go 固有の文字列エスケープ。JavaScript/TypeScript では以下の選択肢がある:

- **方式A**: 各チャンクを base64 エンコードし、文字列連結 → ランタイムで結合してからデコード
- **方式B**: 各チャンクを JS の文字列リテラル（`\x0a` エスケープ等）にする → Go の `%q` に相当
- **方式C**: 各チャンクを個別に base64 エンコードし、ランタイムで個別デコード+結合

`fileDesc()` は base64 文字列を受け取る設計のため、**方式A**（チャンクごとに base64 エンコードし `+` で結合）が最もシンプルで、`fileDesc()` の変更が不要。

## 参考リンク

- [CL 657895](https://go-review.googlesource.com/c/protobuf/+/657895)
- [protocolbuffers/protobuf-go](https://github.com/protocolbuffers/protobuf-go)
- [reflect.go (実装)](https://github.com/protocolbuffers/protobuf-go/blob/master/cmd/protoc-gen-go/internal_gengo/reflect.go)
