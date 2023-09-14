#!/usr/bin/env node
import { parseArgs } from "node:util";
import fs from 'fs';
import path from 'path';


import axios from 'axios';
import openapiTS from 'openapi-typescript';
import parser from '@typescript-eslint/parser';
import Handlebars from "handlebars";

const {values} = parseArgs({
  options: {
    // The import root of the project.
    'project-root': {
      type: 'string',
      default: './src/',
    },
    // the directory of the type directory, relative to the project root.
    'types-dir': {
      type: "string",
      default: "types/",
    },
    // The URL to download the openapi.json file from.
    'openapi-url': {
      type: "string",
      default: "http://localhost:8000/openapi.json",
    },
  },
});

const projectRoot = values['project-root'];
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
const openapiGeneratedPath = path.join(projectRoot, typesDir, 'openapi.generated.d.ts');
fs.writeFileSync(openapiGeneratedPath, typeFile);
const output = parser.parse(typeFile);

const componentsNode = output.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration.id.name === 'components');
const componentProperties = componentsNode.declaration.body.body
const schemasNode = componentProperties.find(node => node.type === 'TSPropertySignature' && node.key.name === 'schemas');
const schemaProperties = schemasNode.typeAnnotation.typeAnnotation.members;
const schemaNames = schemaProperties.map(node => node.key.name);
const openapiPath = path.join(projectRoot, typesDir, 'openapi.generated');

const template = Handlebars.compile(`\
import {components} from '{{openapiPath}}';

{{#each schemaNames}}
export type {{this}} = components["schemas"]["{{this}}"];
{{/each}}
`);
const dataTypesFile = template({schemaNames, openapiPath});
const schemasPath = path.join(projectRoot, typesDir, 'schemas.d.ts');
fs.writeFileSync(schemasPath, dataTypesFile);
