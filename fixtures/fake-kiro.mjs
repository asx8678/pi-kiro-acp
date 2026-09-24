#!/usr/bin/env node
// Offline protocol fixture, not an AI provider. It contacts only the injected loopback MCP endpoint.
import readline from 'node:readline';
import fs from 'node:fs';
const args=process.argv.slice(2);
const taggedInventory=args.includes('--tags-inventory');
if(args.includes('--version')){console.log(taggedInventory?'kiro-cli 2.24.0':'mock-kiro 0.1.0');process.exit(0);}
if(args.includes('--help')){console.log('acp --agent-engine v3 --auth-method cli');process.exit(0);}
if(!args.includes('acp'))process.exit(2);
let session,sequence=0;const running=new Map();const reverse=new Map();
const output=f=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...f})+'\n');
const reply=(id,result)=>output({id,result});
const notify=(method,params)=>output({method,params});
const update=(kind,extra)=>notify('session/update',{sessionId:session.id,update:{sessionUpdate:kind,...extra}});
function options(){return {configOptions:[
  {id:'model',category:'model',type:'select',name:'Model',currentValue:session.model,options:[{value:'auto',name:'Auto'},{value:'test-opus',name:'Test Opus'}]},
  {id:'effortLevel',category:'thought_level',type:'select',name:'Effort',currentValue:session.effort,options:[{value:'low',name:'Low'},{value:'medium',name:'Medium'},{value:'high',name:'High'}]},
]};}
async function mcp(method,params,signal,id){
  const d=session.mcp;if(!d)throw new Error('No MCP');const url=new URL(d.url);
  if(url.hostname!=='127.0.0.1')throw new Error('Fixture refuses non-loopback URLs');
  const headers=Object.fromEntries(d.headers.map(h=>[h.name,h.value]));
  const r=await fetch(d.url,{method:'POST',headers:{...headers,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:id??++sequence,method,params}),signal});
  const json=await r.json();if(json.error)throw new Error(json.error.message);return json.result;
}
async function handle(f){
  if(!f.method){const waiter=reverse.get(f.id);if(waiter){reverse.delete(f.id);waiter(f);}return;}
  const p=f.params??{};
  switch(f.method){
    case 'initialize':{
      const capture=args.indexOf('--capture-initialize');
      if(capture>=0)fs.writeFileSync(args[capture+1],JSON.stringify({params:p,args}),{mode:0o600});
      reply(f.id,{protocolVersion:1,agentInfo:{name:'mock-kiro',version:'0.1.0'},agentCapabilities:{mcpCapabilities:{http:true},promptCapabilities:{image:false}}});break;
    }
    case 'session/new':{
      const agent=p._meta.kiro.customAgents[0];
      session={id:'mock-session-'+(++sequence),model:'auto',effort:'medium',agent,mcp:p.mcpServers[0],tools:[],history:[],mode:'default'};
      if(taggedInventory){
        if(session.mcp){
          await mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
          session.tools=(await mcp('tools/list',{})).tools;
          notify('_kiro/mcp/status',{sessionId:session.id,servers:[{name:'kirocrew-core',status:'connected',tools:session.tools.map(t=>({name:t.name,disabled:false})),_meta:{kiro:{resource:{source:{origin:'client'}}}}}]});
        }
        notify('_kiro/tools/didChange',{sessionId:session.id,tags:[{tag:'shell',source:'builtin'},...session.tools.map(t=>({tag:'@kirocrew-core/'+t.name,source:'mcp'}))]});
      }
      reply(f.id,{sessionId:session.id,...options(),modes:{currentModeId:'default',availableModes:[{id:agent.id,name:'Kiro Crew'}]}});break;
    }
    case 'session/set_mode':{
      if(p.modeId!==session.agent.id)throw new Error('Unknown agent');session.mode=p.modeId;
      if(session.mcp&&!taggedInventory){await mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fixture',version:'1'}});const result=await mcp('tools/list',{});session.tools=result.tools;}
      if(taggedInventory)
        notify('_kiro/tools/didChange',{sessionId:session.id,tags:[...session.tools.map(t=>({tag:'@kirocrew-core/'+t.name,source:'mcp'})),...(args.includes('--extra-tool')?[{tag:'shell',source:'builtin'}]:[])]});
      else
        notify('_kiro/tools/didChange',{sessionId:session.id,tools:[...session.tools.map(t=>({name:'mcp__kirocrew-core__'+t.name})),...(args.includes('--extra-tool')?[{name:'shell'}]:[])]});
      reply(f.id,{...options(),modes:{currentModeId:session.mode}});break;
    }
    case 'session/set_config_option':{
      if(p.configId==='model')session.model=p.value;else if(p.configId==='effortLevel')session.effort=p.value;
      else throw new Error('Unknown configuration option');reply(f.id,options());break;
    }
    case '_session/steer':session.steer=p.message;reply(f.id,{queued:true,messageId:'s-'+(++sequence)});break;
    case 'session/cancel':{
      for(const ctl of running.values())ctl.abort();if(f.id!==undefined)reply(f.id,{});break;
    }
    case 'session/prompt':{
      const ctl=new AbortController();running.set(f.id,ctl);
      try{
        const text=p.prompt.map(b=>b.text).join('\n');session.history.push(text);
        if(text.includes('MODEL_FALLBACK')){session.model='auto';update('config_option_update',options());}
        if(text.includes('MALFORMED_FRAME')){process.stdout.write('not valid json\n');break;}
        if(text.includes('NATIVE_EFFECT')){
          const id='reverse-'+(++sequence);const wait=new Promise(resolve=>reverse.set(id,resolve));
          output({id,method:'fs/write_text_file',params:{sessionId:session.id,path:'/NEVER-WRITTEN',content:'no'}});await wait;
        }
        if(text.includes('DELAY_RESPONSE'))await new Promise((resolve,reject)=>{const t=setTimeout(resolve,10000);ctl.signal.addEventListener('abort',()=>{clearTimeout(t);reject(new Error('cancelled'));},{once:true});});
        const historicalResult=text.includes('"role":"toolResult"');
        if(text.includes('CALL_TOOL')&&!historicalResult){
          update('agent_message_chunk',{content:{type:'text',text:'Requesting a Pi-hosted tool. '}});
          const n=text.includes('TWO_TOOLS')?2:1;
          for(let i=0;i<n;i++){
            const tool=session.tools[0];if(!tool)throw new Error('No tool available');
            const id=++sequence;
            const request=mcp('tools/call',{name:tool.name,arguments:{value:'hello',iteration:i}},ctl.signal,id);
            const duplicate=text.includes('DUPLICATE_TOOL_REQUEST')?mcp('tools/call',{name:tool.name,arguments:{value:'hello',iteration:i}},ctl.signal,id):undefined;
            const result=await request;if(duplicate)await duplicate;
            update('agent_message_chunk',{content:{type:'text',text:`Tool ${i+1}: ${result.isError?'error':'ok'} ${result.content.map(c=>c.text).join(' ')}. `}});
          }
          if(session.steer)update('agent_message_chunk',{content:{type:'text',text:'Steering received: '+session.steer}});
        }else{
          update('agent_message_chunk',{content:{type:'text',text:`[${session.model}] ${historicalResult?'Resynchronized from Pi history without repeating its tool.':text.slice(-256)}`}});
        }
        reply(f.id,{stopReason:'end_turn'});
      }catch(e){reply(f.id,{stopReason:ctl.signal.aborted?'cancelled':'end_turn'});}
      finally{running.delete(f.id);}break;
    }
    default:output({id:f.id,error:{code:-32601,message:'Unsupported fixture method: '+f.method}});
  }
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{
  try{const f=JSON.parse(line);void handle(f).catch(e=>output({id:f.id,error:{code:-32000,message:e.message}}));}
  catch{process.exitCode=2;}
});
process.stdin.on('end',()=>process.exit());
