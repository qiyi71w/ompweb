import '../tests/setup-dom.mjs';
import assert from 'node:assert/strict';
import test,{afterEach} from 'node:test';
import React from 'react';
import {cleanup,render,waitFor} from '@testing-library/react/pure.js';
import userEvent from '@testing-library/user-event';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{tsconfigPaths:true,jsx:{runtime:'automatic'}});
const {McpConfig}=await jiti.import('./McpConfig.tsx');
const {MCP_EDITABLE_FIELDS}=await jiti.import('../lib/omp/mcp-contract.ts');
const originalFetch=globalThis.fetch;
afterEach(()=>{cleanup();globalThis.fetch=originalFetch;});
function view(){return {context:{id:'context'},root:'/workspace',path:'/workspace/.omp/mcp.json',createBaseline:'create',servers:[{name:'local',config:{command:'node',args:[]},valid:true,enabled:true,baseline:'entity',fields:Object.fromEntries(MCP_EDITABLE_FIELDS.map(f=>[f,`original-${f}`])),credentials:{env:true,headers:false}}],projectLoading:{native:{known:true,value:false}},inventory:[{name:'local',source:'Project level',valid:true,enabled:true,type:'stdio'}],live:{state:'not-running',sessionId:'session',servers:[]}};}
test('static visit never requests a start, keeps disabled-loading files editable, and explicitly starts on click',async()=>{
 const calls=[];globalThis.fetch=async(url,options={})=>{calls.push({url,options});return {ok:true,json:async()=>options.method==='POST'?{...view(),live:{state:'observed',sessionId:'session',servers:[{name:'local',source:'Project level',listed:true,loaded:null,connected:null}]}}:view()}};
 const ui=render(React.createElement(McpConfig,{cwd:'/workspace',sessionId:'session'}));
 const start=await ui.findByRole('button',{name:'Start this session and query MCP'});
 assert.equal(calls.length,1);assert.equal(calls[0].options.method,undefined);
 await userEvent.click(ui.getByRole('button',{name:/^local stdio/}));
 assert.equal(ui.getByRole('button',{name:'Save server'}).disabled,false);
 await userEvent.click(start);
 await waitFor(()=>assert.equal(calls.length,2));
 assert.equal(JSON.parse(calls[1].options.body).action,'start-live');
 assert.equal(JSON.parse(calls[1].options.body).contextId,'context');
 await ui.findByText(/Loaded: Unknown/);
});
test('one field intent retains the original baseline and a conflict prevents replay',async()=>{
 const writes=[];globalThis.fetch=async(_url,options={})=>{
  if(options.method==='POST'){writes.push(JSON.parse(options.body));return {ok:false,status:409,json:async()=>({code:'conflict',latest:{...view(),servers:[{...view().servers[0],config:{command:'external'},fields:{...view().servers[0].fields,command:'fresh'}}]}})}}
  return {ok:true,json:async()=>view()};
 };
 const ui=render(React.createElement(McpConfig,{cwd:'/workspace',sessionId:'session'}));
 await userEvent.click(await ui.findByRole('button',{name:/^local stdio/}));
 const editor=ui.getByLabelText('OMP server configuration (JSON)');
 await userEvent.clear(editor);await userEvent.click(editor);await userEvent.paste(JSON.stringify({command:'bun',args:[]}));
 await userEvent.click(ui.getByRole('button',{name:'Save server'}));
 await waitFor(()=>assert.equal(writes.length,1));
 assert.deepEqual(writes[0].operations,[{op:'set',name:'local',field:'command',value:'bun',baseline:'original-command'}]);
 await ui.findByText(/Nothing was replayed/);
 assert.equal(ui.getByRole('button',{name:'Save server'}).disabled,true);
 await userEvent.click(ui.getByRole('button',{name:'Save server'}));assert.equal(writes.length,1);
 await userEvent.click(ui.getByRole('button',{name:/^local stdio/}));
 assert.equal(ui.getByLabelText('OMP server configuration (JSON)').value,JSON.stringify({command:'external'},null,2));
});
