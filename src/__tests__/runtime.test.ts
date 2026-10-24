import {
  create,
  equals,
  fromBinary,
  getExtension,
  setExtension,
  toBinary,
  toJson,
} from "@bufbuild/protobuf";
import {
  messageDesc as messageDescByPath,
  pathInFileDesc,
} from "@bufbuild/protobuf/codegenv2";
import { nestedTypes } from "@bufbuild/protobuf/reflect";
import { describe, expect, it } from "vitest";
import { enumDesc, extDesc, messageDesc, serviceDesc } from "../runtime.js";
// Generated code, so that schemas are obtained by name as in an application.
import {
  EditionsMessage_ChildSchema,
  EditionsMessageSchema,
} from "./golden/__snapshots__/editions_pb.js";
import {
  ExtendableSchema,
  file_extensions,
  Holder_nested,
  top_level,
} from "./golden/__snapshots__/extensions_pb.js";
import {
  Availability,
  InventorySchema,
} from "./golden/__snapshots__/map_pb.js";
import { file_nested } from "./golden/__snapshots__/nested_pb.js";
import {
  Event_ClickSchema,
  EventSchema,
} from "./golden/__snapshots__/oneof_pb.js";
import { ProfileSchema } from "./golden/__snapshots__/optional_pb.js";
import { EnvelopeSchema } from "./golden/__snapshots__/public_import_pb.js";
import { file_service } from "./golden/__snapshots__/service_pb.js";

describe("messages from generated code", () => {
  it.each([
    {
      schema: ProfileSchema,
      init: {
        id: "1",
        nickname: "",
        bio: "b",
        contact: { case: "email", value: "e" },
        parent: { id: "0" },
      },
      json: {
        id: "1",
        nickname: "",
        bio: "b",
        email: "e",
        parent: { id: "0" },
      },
    },
    {
      schema: EventSchema,
      init: {
        kind: {
          case: "click",
          value: create(Event_ClickSchema, {
            x: 1,
            target: { case: "link", value: "l" },
          }),
        },
        source: { case: "app", value: 2 },
      },
      json: { click: { x: 1, link: "l" }, app: 2 },
    },
    {
      schema: InventorySchema,
      init: {
        counts: { a: 1 },
        items: { "3": { name: "n" } },
        availability: { a: Availability.SOLD_OUT },
      },
      json: {
        counts: { a: 1 },
        items: { "3": { name: "n" } },
        availability: { a: "AVAILABILITY_SOLD_OUT" },
      },
    },
    {
      schema: EnvelopeSchema,
      init: { a: { id: "a" }, b: { id: "b" } },
      json: { a: { id: "a" }, b: { id: "b" } },
    },
    {
      schema: EditionsMessageSchema,
      init: {
        count: 0,
        values: [1, 2],
        child: create(EditionsMessage_ChildSchema, { value: "c" }),
      },
      json: { count: 0, values: [1, 2], child: { value: "c" } },
    },
  ])("$schema.typeName: create, toBinary, fromBinary and toJson", ({
    schema,
    init,
    json,
  }) => {
    // biome-ignore lint/suspicious/noExplicitAny: each case has its own shape
    const message = create(schema, init as any);
    const decoded = fromBinary(schema, toBinary(schema, message));
    expect(equals(schema, decoded, message)).toBe(true);
    expect(toJson(schema, decoded)).toEqual(json);
  });

  it("keeps synthetic oneofs out of the real ones", () => {
    expect(ProfileSchema.oneofs.map((o) => o.name)).toEqual(["contact"]);
    expect(ProfileSchema.field.nickname.oneof).toBeUndefined();
    expect(ProfileSchema.field.email.oneof?.name).toBe("contact");
    expect(ProfileSchema.field.nickname.proto.oneofIndex).toBe(1);
    expect(ProfileSchema.field.bio.proto.oneofIndex).toBe(3);
    expect(ProfileSchema.proto.oneofDecl.map((o) => o.name)).toEqual([
      "contact",
      "_nickname",
      "_age",
      "X_bio",
      "_parent",
    ]);
  });

  it("resolves public imports", () => {
    expect(EnvelopeSchema.file.proto.publicDependency).toEqual([1]);
    expect(EnvelopeSchema.field.b.message?.typeName).toBe("testdata.dep.B");
  });

  it("gets and sets extensions obtained by name", () => {
    const message = create(ExtendableSchema);
    setExtension(message, top_level, "t");
    setExtension(message, Holder_nested, 7);
    const decoded = fromBinary(
      ExtendableSchema,
      toBinary(ExtendableSchema, message),
    );
    expect(getExtension(decoded, top_level)).toBe("t");
    expect(getExtension(decoded, Holder_nested)).toBe(7);
  });
});

describe("lookups", () => {
  it("find every element by name and by path", () => {
    for (const file of [file_nested, file_extensions, file_service]) {
      const prefix = `${file.proto.package}.`;
      for (const element of nestedTypes(file)) {
        const name = element.typeName.slice(prefix.length);
        const [first, ...rest] = pathInFileDesc(element);
        const lookup = {
          message: messageDesc,
          enum: enumDesc,
          service: serviceDesc,
          extension: extDesc,
        }[element.kind];
        expect(lookup(file, name)).toBe(element);
        expect(lookup(file, first, ...rest)).toBe(element);
      }
    }
  });

  it("delegate paths to codegenv2", () => {
    expect(messageDesc(file_nested, 0, 0)).toBe(
      messageDescByPath(file_nested, 0, 0),
    );
  });

  it("throw for a missing name or another kind", () => {
    expect(() => messageDesc(file_nested, "Missing")).toThrow(
      "message Missing not found in nested.proto",
    );
    expect(() => messageDesc(file_nested, "Outer.Kind")).toThrow(
      "message Outer.Kind not found in nested.proto",
    );
  });
});
