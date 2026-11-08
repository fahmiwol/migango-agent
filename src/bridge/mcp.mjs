const string = {type:'string'};
const id = {...string, format:'uuid'};
const definitions = [
  ['status','Read app/workspace/model and running status.',{},[],true],
  ['start','Start one task inside MiganGO. Same requestId+input is safe to retry within this app session. Model calls may spend owner credit.',
    {requestId:id, expectedWorkspace:string, prompt:{...string,minLength:2,maxLength:12000},mode:{type:'string',enum:['ask','work']},modelId:{...string,maxLength:60}},
    ['requestId','expectedWorkspace','prompt','mode'],false],
  ['operation','Read progress for one operation started by this bridge.',{operationId:id},['operationId'],true],
  ['result','Read the bounded, redacted result of one operation.',{operationId:id},['operationId'],true],
  ['stop','Stop that active bridge operation using the app cancellation path.',{operationId:id,expectedWorkspace:string},['operationId','expectedWorkspace'],false],
  ['approvals','Read exact pending file approval previews. Review digest, content and workspace before deciding.',{},[],true],
  ['decide','Resolve one pending exact approval. Grant only file operations; shell/SSH/desktop grants are unavailable. Never auto-approve.',
    {id:string,digest:{...string,pattern:'^[a-f0-9]{64}$'},yes:{type:'boolean'},expectedWorkspace:string},['id','digest','yes','expectedWorkspace'],false],
];
export const bridgeTools = definitions.map(([method,description,properties,required,readOnly]) => ({
  name:'migango_' + method, description, inputSchema:{type:'object',properties,required,additionalProperties:false},
  annotations:{readOnlyHint:readOnly, destructiveHint:!readOnly, idempotentHint:readOnly || method==='start',openWorldHint:method==='start'},
}));
export function createMcpHandler({call}) {
  let initialized = false;
  return async message => {
    const id = message?.id ?? null;
    const error = (code, text) => ({jsonrpc:'2.0',id,error:{code,message:text}});
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
      return error(-32600,'Invalid JSON-RPC request');
    if (message.id === undefined) return null;
    if (message.method === 'initialize') {
      initialized = true;
      return {jsonrpc:'2.0',id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},
        serverInfo:{name:'migango-local',version:'0.1.0'},
        instructions:'Use the same app workspace. Never approve file writes without inspecting the exact pending preview. No credential operations.'}};
    }
    if (message.method === 'ping') return {jsonrpc:'2.0',id,result:{}};
    if (!initialized) return error(-32002,'Initialize first');
    if (message.method === 'tools/list') return {jsonrpc:'2.0',id,result:{tools:bridgeTools}};
    if (message.method !== 'tools/call') return error(-32601,'Method not found');
    try {
      const {name, arguments:args = {}} = message.params || {};
      const tool = bridgeTools.find(tool => tool.name === name);
      if (!tool) throw Error('Unknown MiganGO tool');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Expected arguments object');
      const schema = tool.inputSchema;
      for (const key of Object.keys(args)) if (!Object.hasOwn(schema.properties,key)) throw Error('Unknown argument: ' + key);
      for (const key of schema.required) if (!Object.hasOwn(args,key)) throw Error('Missing argument: ' + key);
      for (const [key,value] of Object.entries(args)) {
        const property = schema.properties[key];
        if (typeof value !== property.type || (property.enum && !property.enum.includes(value)) ||
            (property.maxLength && value.length > property.maxLength) ||
            (property.minLength && value.length < property.minLength) ||
            (property.pattern && !new RegExp(property.pattern).test(value))) throw Error('Invalid argument: ' + key);
      }
      const result = await call(name.slice('migango_'.length), args);
      return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],isError:false}};
    } catch (e) {
      return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:String(e.message).slice(0,1000)}],isError:true}};
    }
  };
}
