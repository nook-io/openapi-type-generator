#!/usr/bin/env node
import { parseArgs } from "node:util";
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import parser from '@typescript-eslint/parser';
import openapiTS, { astToString } from 'openapi-typescript';
import ts from "typescript";

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
      },
      // Number of milliseconds to wait for the OpenAPI file to be
      // fetched before timing out. 
      'timeout': {
        type: 'string',
        default: '30000'
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
  args['timeout'] = Number(args['timeout']);
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
          }, args['timeout'])
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
 * Generate a re-exporter file for the generated types. This file
 * imports the components file from the generated OpenAPI types file
 * and re-exports all the schemas from it, as well as re-exporting all
 * enums. The purpose of this file is to flatten the generated types, so
 * you can use a type like `const x: MySchema` instead of
 * `const x: components['schemas']['MySchema']`.
 */
function generateReExporterFile(typeFile, typesDir, enumNames) {
  const output = parser.parse(typeFile);
  const componentsNode = output.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration.id.name === 'components');
  const componentProperties = componentsNode.declaration.body.body
  const schemasNode = componentProperties.find(node => node.type === 'TSPropertySignature' && node.key.name === 'schemas');
  const schemaProperties = schemasNode.typeAnnotation.typeAnnotation.members;
  const openAPIPath = path.join(typesDir, 'openapi');
  
  let reExporterLines = [`import { components } from '${openAPIPath}';\n`];
  if (enumNames.size > 0) {
    reExporterLines.push('export {');
    for (const enumName of enumNames) {
      reExporterLines.push(`  ${enumName},`);
    }
    reExporterLines.push(`} from '${openAPIPath}';`);
  }
  reExporterLines.push('');

  reExporterLines = reExporterLines.concat(schemaProperties.filter(schemaProperty => !enumNames.has(schemaProperty.key.name)).map(schemaProperty => {
    const schemaName = schemaProperty.key.name || schemaProperty.key.value;
    const cleanSchemaName = schemaName.replace(/([^\w\d])|(^[^a-zA-Z]+)/g, '');
    const isEnum = schemaProperty.key.type === 'Identifier' && enumNames.has(schemaName);
    return `export ${isEnum ? "const" : "type"} ${cleanSchemaName} = components['schemas']['${schemaName}'];`;
  }));
  reExporterLines.push('');
  return reExporterLines.join('\n');
}

const { args, importOrder } = getArgs();
const openAPISchema = await loadOpenAPISchema(args, importOrder);
const openAPIGeneratedPath = path.join(args['project-root'], args['types-dir'], 'openapi.ts');

let ast;
try {
  ast = await openapiTS(openAPISchema, { enum: true, defaultNonNullable: false});
} catch (e) {
  console.log(e);
  process.exit(0);
}
const typeFile = astToString(ast);
fs.writeFileSync(openAPIGeneratedPath, typeFile);
const enumNames = new Set(ast.filter((node) => node.kind === ts.SyntaxKind.EnumDeclaration).map((node) => node.name.escapedText));
const reExporterFile = generateReExporterFile(typeFile, args['types-dir'], enumNames);
const schemasPath = path.join(args['project-root'], args['types-dir'], 'schemas.ts');
fs.writeFileSync(schemasPath, reExporterFile);
if (args['auto-add']) {
  try {
    execSync(`git add ${openAPIGeneratedPath} ${schemasPath}`, { stdio: 'inherit' }); 
  } catch (e) {
    // We're not inside the Git repo, so we can't add the files.
  }
}
