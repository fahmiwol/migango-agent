module.exports=async function({app,safeStorage},data){
 const {Store}=await import(data.storage);const {invokeModel}=await import(data.provider);
 const store=new Store(app.getPath('userData'),safeStorage);await store.init();
 const response=await invokeModel({profile:{provider:'anthropic',model:'claude-opus-5-5'},key:store.keys.anthropic,system:data.system||'You are a software engineer implementing defensive validation of structured process metadata. Return only complete JavaScript module source without Markdown. Do not claim tests ran.',messages:[{role:'user',content:data.prompt}],tools:[],maxOutput:4096,signal:new AbortController().signal});
 return {source:store.redact(response.text),usage:response.usage,finishReason:response.finishReason};
};
