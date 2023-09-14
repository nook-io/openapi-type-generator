import axios from 'axios';
import fs from 'fs';
import openapiTS from 'openapi-typescript';
import parser from '@typescript-eslint/parser';
import Handlebars from "handlebars";

let response;
try {
  response = await axios.get('http://localhost:8000/openapi.json');
} catch (e) {
  console.log("Can't download openapi.json from localhost:8000. Please start the backend and try again.");
  return
}
const typeFile = await openapiTS(response.data);
fs.writeFileSync('../../src/types/openapi.generated.d.ts', typeFile);
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
fs.writeFileSync('../../src/types/schemas.d.ts', dataTypesFile);
