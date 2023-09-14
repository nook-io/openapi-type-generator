# openapi-type-generator

Generate a TypeScript types from an OpenAPI file. This essentially just runs
`openapi-typescript` and creates a `schemas.d.ts` that re-exports just the
generated schemas. Without re-exporting, types would looks as follows:

```
const x: components["schemas"]["MyType"] = {};
```

The re-exporter allow types to be used as follows:

```
const x: MyType = {};
```