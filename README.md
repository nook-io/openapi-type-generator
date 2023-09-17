# openapi-type-generator

Generate a TypeScript types file from an OpenAPI file. This essentially
just runs `openapi-typescript` with a transformer to output enums as
TypeScript enums, rather than type unions. It also creates a
`schemas.d.ts` that re-exports just the generated schemas.

Without re-exporting, types would looks as follows:
```
const x: components["schemas"]["MyType"] = {};
```

With re-exporting, types can be used as:
```
const x: MyType = {};
```