import { parseArgs } from "node:util";
import fs from 'fs';
import path from 'path';


import axios from 'axios';
import openapiTS from 'openapi-typescript';
import parser from '@typescript-eslint/parser';
import Handlebars from "handlebars";

const {values} = parseArgs({
  options: {
    'types-dir': {
      type: "string",
      default: "src/types",
    },
    'openapi-url': {
      type: "string",
      default: "http://localhost:8000/openapi.json",
    },
  },
});

const typesDir = values['types-dir'];
const openapiUrl = values['openapi-url'];

let response;
try {
  response = await axios.get(openapiUrl);
} catch (e) {
  console.log("Can't download openapi.json from localhost:8000. Please start the backend and try again.");
  return
}
const typeFile = await openapiTS(response.data);
const openapiGeneratePath = path.join(typesDir, 'openapi.generated.d.ts');
fs.writeFileSync(openapiGeneratePath, typeFile);
const output = parser.parse(typeFile);

const componentsNode = output.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration.id.name === 'components');
const componentProperties = componentsNode.declaration.body.body
const schemasNode = componentProperties.find(node => node.type === 'TSPropertySignature' && node.key.name === 'schemas');
const schemaProperties = schemasNode.typeAnnotation.typeAnnotation.members;
const schemaNames = schemaProperties.map(node => node.key.name);

const template = Handlebars.compile(`\
import {components} from 'types/openapi.generated';

{{#each schemas}}
export type {{this}} = components["schemas"]["{{this}}"];
{{/each}}
`);
const dataTypesFile = template({schemas: schemaNames});
const schemasPath = path.join(typesDir, 'schemas.d.ts');
fs.writeFileSync(schemasPath, dataTypesFile);
