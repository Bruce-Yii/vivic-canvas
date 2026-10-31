import { build } from '../apps/web/node_modules/vite/dist/node/index.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';

const repo = resolve(import.meta.dirname, '..');
const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg) throw new Error('Usage: node scripts/build-card-package-patch.mjs <release-copy> <new-destination>');
const source = resolve(sourceArg), destination = resolve(destinationArg);
const childPath=relative(source,destination);
if (existsSync(destination) || !childPath || !childPath.startsWith('..'+sep) && !isAbsolute(childPath)) throw new Error('Destination must be new and outside source');
const patch = join(repo, 'deploy/online-patches/card-packages-20261030-1');
const release = 'card-packages-20261030-1';
const original = join(source, 'web/assets/unified-background-20261029-1');
const initialHtml=readFileSync(join(source,'web/index.html'),'utf8');
const startup=initialHtml.match(/src="\/assets\/unified-background-20261029-1\/(vivic-startup-v\d+\.js)"/)?.[1];
if (!startup || !existsSync(join(original,startup))) throw new Error('Expected versioned current frontend entry');
const sha = value => createHash('sha256').update(value).digest('hex');
if (sha(readFileSync(join(original, 'src-BByP9_62.js'))) !== '624a638c8815df2758d2b195958be3f6a53c48ab06d9ef3bce55bad6100bbdfb') throw new Error('Unexpected base runtime; inspect the current release before patching');
cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
const assets = join(destination, 'web/assets', release);
cpSync(original, assets, { recursive: true, errorOnExist: true, force: false });
for (const name of readdirSync(assets)) {
  if (!/\.(?:js|css)$/.test(name)) continue;
  const path = join(assets, name), content = readFileSync(path, 'utf8');
  writeFileSync(path, content.replaceAll('assets/unified-background-20261029-1/', `assets/${release}/`).replaceAll('assets/light-default-20261029-1/', `assets/${release}/`));
}
const generated = join(patch, 'generated'); mkdirSync(generated, { recursive: true });
const runtimeEntry = join(generated, 'runtime-entry.ts');
writeFileSync(runtimeEntry, `import * as runtime from "../../../../packages/card-runtime/src/index";\nexport { revalidateDefinition as a, validateValue as c, resolvePointer as i, checkJsonBudget as l, definitionRef as n, parsePackageFiles as r, validateInstance as s, definitionKey as t, isObject as u } from "../../../../packages/card-runtime/src/index";\nexport { runtime as o };\n`);
const bridge = {
  react: `import {t} from "/assets/${release}/react-CQOZoUwg.js";const R=t();export default R;export const {useEffect,useRef,useState,useCallback,useContext,useMemo,createContext}=R;`,
  'react/jsx-runtime': `import {t} from "/assets/${release}/jsx-runtime-DREnUpxT.js";export const {jsx,jsxs,Fragment}=t();`,
  './client': `export {t as HostedApiError,i as hostedRequest} from "/assets/${release}/client-DPyQbKzT.js";`,
  './HostedDefinitions': `import {announceDefinitionChange} from ${JSON.stringify(join(repo, 'apps/web/src/hosted/definitionChanges.ts').replaceAll('\\','/'))};export function useRefreshHostedDefinitions(){return announceDefinitionChange;}`,
  '@vivic/card-runtime': `import {o as runtime} from "/assets/${release}/src-BByP9_62.js";export const {definitionKey,definitionRef,PACKAGE_LIMITS,readPackageZip,resolvePointer,revalidateDefinition}=runtime;`,
};
const external = id => id.startsWith(`/assets/${release}/`);
await build({configFile:false,root:repo,logLevel:'warn',build:{outDir:assets,emptyOutDir:false,minify:true,lib:{entry:runtimeEntry,formats:['es'],fileName:()=> 'src-BByP9_62.js'},rolldownOptions:{output:{codeSplitting:false}}}});
await build({configFile:false,root:repo,logLevel:'warn',plugins:[{name:'current-release-bridges',enforce:'pre',resolveId(id, importer){if(id in bridge && (id !== './client' && id !== './HostedDefinitions' || importer?.endsWith('HostedCardPackages.tsx')))return '\0bridge:'+id;},load(id){if(id.startsWith('\0bridge:'))return bridge[id.slice(8)];}}],build:{outDir:assets,emptyOutDir:false,minify:true,cssCodeSplit:false,lib:{entry:join(repo,'apps/web/src/hosted/HostedCardPackages.tsx'),formats:['es'],fileName:()=> 'card-packages.js',cssFileName:'card-packages'},rolldownOptions:{external,output:{codeSplitting:false}}}});
const replaceOnce = (path, before, after) => { const value=readFileSync(path,'utf8'); if(value.split(before).length!==2)throw new Error(`Patch anchor missing or ambiguous: ${path}`);writeFileSync(path,value.replace(before,after)); };
for (const name of ['ControlApp-TutorialEntry20261029.js','ControlApp-TutorialEntry20261030.js'].filter(name=>existsSync(join(assets,name)))) {
  const control = join(assets,name);
  writeFileSync(control, 'import{HostedCardPackages as VivicHostedCardPackages}from"./card-packages.js";\n'+readFileSync(control,'utf8'));
  replaceOnce(control, '(0,q.jsx)(Ql,{host:e.host,readonly:n||!t.ready,onBeforeClear:e.onCancel,compact:!0})', '(0,q.jsx)(VivicHostedCardPackages,{}),(0,q.jsx)(Ql,{host:e.host,readonly:n||!t.ready,onBeforeClear:e.onCancel,compact:!0})');
}
const settings=join(assets,'HostedSettings-BAvxHXOr.js');
writeFileSync(settings, 'import{HostedCardPackages as VivicHostedCardPackages}from"./card-packages.js";\n'+readFileSync(settings,'utf8'));
replaceOnce(settings, '(0,_.jsxs)(`section`,{children:[(0,_.jsx)(`h3`,{children:`数据`})', '(0,_.jsx)(VivicHostedCardPackages,{}),(0,_.jsxs)(`section`,{children:[(0,_.jsx)(`h3`,{children:`数据`})');
// The latest entry and legacy imported facade hold separate providers. Both must hear changes.
for (const name of readdirSync(assets).filter(name=>/^app-runtime(?:-v\d+)?\.js$/.test(name) && readFileSync(join(assets,name),'utf8').includes('o=(0,A.useCallback)(()=>r(e=>e+1),[]);(0,A.useEffect)(()=>{if(!e)'))) {
  replaceOnce(join(assets,name), 'o=(0,A.useCallback)(()=>r(e=>e+1),[]);(0,A.useEffect)(()=>{if(!e)', 'o=(0,A.useCallback)(()=>r(e=>e+1),[]);(0,A.useEffect)(()=>{window.addEventListener("vivic:card-packages-changed",o);const channel=typeof BroadcastChannel==="undefined"?null:new BroadcastChannel("vivic.card-packages.v1");if(channel)channel.onmessage=event=>{if(event.data==="changed")o()};return()=>{window.removeEventListener("vivic:card-packages-changed",o);channel?.close()}},[o]);(0,A.useEffect)(()=>{if(!e)');
}
const indexPath=join(destination,'web/index.html');
writeFileSync(indexPath, readFileSync(indexPath,'utf8').replaceAll('unified-background-20261029-1',release).replace('</head>',`<link rel="stylesheet" href="/assets/${release}/card-packages.css"></head>`));
const headersPath=join(destination,'frontend-headers.conf');
writeFileSync(headersPath,readFileSync(headersPath,'utf8').replaceAll('unified-background-20261029-1',release));
const files=[];
function manifest(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const p=join(dir,item.name);if(item.isDirectory())manifest(p);else files.push({path:p.slice(destination.length+1).replaceAll('\\','/'),sha256:sha(readFileSync(p))});}}
manifest(assets);files.push({path:'web/index.html',sha256:sha(readFileSync(indexPath))},{path:'frontend-headers.conf',sha256:sha(readFileSync(headersPath))});
writeFileSync(join(destination,'publication-card-packages.json'),JSON.stringify({release,base:'unified-background-20261029-1',startup,files},null,2)+'\n');
console.log(JSON.stringify({release,destination,files:files.length}));
