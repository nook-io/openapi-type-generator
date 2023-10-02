#!/usr/bin/env node
import { parseArgs } from "node:util";
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import pkg from './package.json' assert { type: "json" };

import parser from '@typescript-eslint/parser';
import hash from 'object-hash';
import openapiTS from 'openapi-typescript';

function isOptionToken(token) {
  return token.kind === 'option';
}

function getArgs() {
  const { values: args, tokens } = parseArgs({
    options: {
      // The import root of the JS project.
      'project-root': {
        type: 'string',
        default: './src/',
      },
      // the directory of the type directory, relative to the project root.
      'types-dir': {
        type: "string",
        default: "types/",
      },
      // The URL to download the OpenAPI file from.
      'oas-url': {
        type: "string",
        default: ""
      },
      // The path to the OpenAPI file from.
      'oas-path': {
        type: "string",
        default: ""
      },
      // A command to an executable that outputs the OpenAPI file.
      'oas-command': {
        type: "string",
        default: ""
      },
      // The working directory to run the command in.
      'command-cwd': {
        type: "string",
        default: ""
      },
      // Automatically add the changed files after generation. These
      // changed files may not be picked up by subsequent pre-commit
      // hooks.
      'auto-add': {
        type: "boolean",
        default: false
      }
    },
    tokens: true
  });

  if (!args['oas-url'] && !args['oas-path'] && !args['oas-command']) {
    console.log('Must provide either --oas-url, --oas-path or --oas-command');
    process.exit(0);
  }

  if (args['command-cwd'] && !args['oas-command']) {
    console.log('Must provide --oas-command if --command-cwd is provided');
    process.exit(0);
  }

  const importOrder = tokens
    .filter(isOptionToken)
    .filter(token => token.name.startsWith('oas'))
    .sort((a, b) => a.index - b.index)
    .map(token => token.name);

  return { args, importOrder };
}

/**
 * Load the OpenAPI schema from the given source.
 */
async function loadOpenAPISchema(args, importOrder) {
  let openAPIFile;
  for (const importKey of importOrder) {
    try {
      switch (importKey) {
        case 'oas-path':
          openAPIFile = fs.readFileSync(args['oas-path']);
          return JSON.parse(openAPIFile);
        case 'oas-command': {
          const options = {};
          if (args['command-cwd']) {
            options.cwd = args['command-cwd'];
          }
          openAPIFile = execSync(args['oas-command'], options);
          return JSON.parse(openAPIFile);
        }
        case 'oas-url': {
          const controller = new AbortController()
          const timeout = setTimeout(() => {
            controller.abort()
          }, 5000)
          let response;
          response = await fetch(args['oas-url'], { signal: controller.signal });
          clearTimeout(timeout)
          return await response.json();
        }
      }
    }
    catch (e) {
      console.log(`Could not load OpenAPI file using ${importKey}: ${e}`);
      continue;
    }
  }
  console.log('Could not load OpenAPI file');
  process.exit(0)
}

/**
 * Convert an enum schema into a string representation of a
 * TypeScript enum.
 */
function formatEnum(enumSchema) {
  const enumName = enumSchema.title;
  const commentString = enumSchema.description ? `/**\n * ${enumSchema.description}\n */\n` : '';
  const enumValues = enumSchema.enum
    .map((value) => `  ${JSON.stringify(value)} = ${JSON.stringify(value)}`)
    .join(',\n');
  return `\
${commentString}\
export enum ${enumName.replace(/[^\w\d]/, '')} {
${enumValues}
}`;
}

/**
 * Transform union enums into a single enum when they have their own
 * schema, i.e. are referenced through a $ref, not inlined. Used with
 * openapiTS.
 */
function transform(schemaObject, metadata) {
  if (!('enum' in schemaObject)) {
    return '';
  }
  if (schemaObject.type !== 'string') {
    return '';
  }
  const enumName = schemaObject.title;
  if (!enumName) {
    return '';
  }
  const schemaName = metadata.path.split('/').at(-1);
  if (schemaName !== enumName) {
    return '';
  }
  if (!enumLookup[enumName]) {
    enumLookup[enumName] = schemaObject;
  }
  return enumName;
}

/**
 * Get the schemas hash specified in the given OpenAPI type file, if any.
 */
function getSchemaHash(openAPITypesPath) {
  const openAPIFile = fs.readFileSync(openAPITypesPath);
  const output = parser.parse(openAPIFile);
  const schemaHashNodes = output.body.filter(node => node.type === 'ExportNamedDeclaration' && node.declaration.kind === 'const' && node.declaration.declarations[0].id.name == 'schemaHash');
  if (schemaHashNodes.length === 0) {
    return null;
  }
  return schemaHashNodes[0].declaration.declarations[0].init.value;
}

/**
 * Generate a re-exporter file for the generated types. This file
 * imports the components file from the generated OpenAPI types file
 * and re-exports all the schemas from it, as well as re-exporting all
 * enums. The purpose of this file is to flatten the generated types, so
 * you can use a type like `const x: MySchema` instead of
 * `const x: components['schemas']['MySchema']`.
 */
function generateReExporterFile(typeFile, typesDir, enumLookup) {
  const output = parser.parse(typeFile);
  const componentsNode = output.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration.id.name === 'components');
  const componentProperties = componentsNode.declaration.body.body
  const schemasNode = componentProperties.find(node => node.type === 'TSPropertySignature' && node.key.name === 'schemas');
  const schemaProperties = schemasNode.typeAnnotation.typeAnnotation.members;
  const openAPIPath = path.join(typesDir, 'openapi');
  
  let reExporterLines = [`import { components } from '${openAPIPath}';\n`];
  if (Object.keys(enumLookup).length > 0) {
    reExporterLines.push('export {');
    for (const enumName in enumLookup) {
      reExporterLines.push(`  ${enumName},`);
    }
    reExporterLines.push(`} from '${openAPIPath}';`);
  }
  reExporterLines.push('');

  reExporterLines = reExporterLines.concat(schemaProperties.filter(schemaProperty => !(schemaProperty.key.name in enumLookup)).map(schemaProperty => {
    const schemaName = schemaProperty.key.name;
    const isEnum = schemaProperty.key.type === 'Identifier' && schemaName in enumLookup;
    return `export ${isEnum ? "const" : "type"} ${schemaName} = components['schemas']['${schemaName}'];`;
  }));
  reExporterLines.push('');
  return reExporterLines.join('\n');
}

const { args, importOrder } = getArgs();
const openAPISchema = await loadOpenAPISchema(args, importOrder);
const schemaHash = hash({...openAPISchema, typeGeneratorVersion: pkg.version});
const openAPIGeneratedPath = path.join(args['project-root'], args['types-dir'], 'openapi.ts');
const prevSchemaHash = getSchemaHash(openAPIGeneratedPath)
if (prevSchemaHash === schemaHash) {
  console.log("OpenAPI file has not changed, skipping generation.");
  process.exit(0);
}
const enumLookup = {};

let typeFile;
try {
  typeFile = await openapiTS(openAPISchema, { transform });
} catch (e) {
  console.log(e);
  process.exit(0);
}
typeFile += `\nexport const schemaHash = '${schemaHash}';\n`;
// Add enum definitions to the generated types file.
const enumDefs = Object.values(enumLookup).map((enumSchema) => formatEnum(enumSchema)).join('\n');
typeFile += '\n' + enumDefs + '\n';

fs.writeFileSync(openAPIGeneratedPath, typeFile);
const reExporterFile = generateReExporterFile(typeFile, args['types-dir'], enumLookup);
const schemasPath = path.join(args['project-root'], args['types-dir'], 'schemas.ts');
fs.writeFileSync(schemasPath, reExporterFile);
if (args['auto-add']) {
  try {
    execSync(`git add ${openAPIGeneratedPath} ${schemasPath}`, { stdio: 'inherit' }); 
  } catch (e) {
    // We're non inside the Git repo, so we can't add the files.
  }
}
