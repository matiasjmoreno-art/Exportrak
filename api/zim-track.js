// v2 - deploy via GitHub Actions
// api/zim-track.js
const ZIM_CLIENT_ID="060221d3-49e9-43da-b507-348a67c1c9b6";
const ZIM_CLIENT_SECRET="WPC8Q~wA0LHiFLaVAtmTcifyIYzcWJ0Fg6hMeda~";
const ZIM_SUB_KEY="caea18b0a6c6420e9c3bf1893011a641";
const ZIM_BASE="https://apigw.zim.com/tracing/v2";
let tc={token:null,expiry:0};
async function getToken(){
  const now=Date.now();
  if(tc.token&&now<tc.expiry-30000)return tc.token;
  for(const u of["https://login.microsoftonline.com/zimidapimprod.onmicrosoft.com/oauth2/v2.0/token","https://zimidapimprod.b2clogin.com/zimidapimprod.onmicrosoft.com/oauth2/v2.0/token"]){
    try{const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"client_credentials",client_id:ZIM_CLIENT_ID,client_secret:ZIM_CLIENT_SECRET,scope:ZIM_CLIENT_ID+"/.default"}).toString()});if(r.ok){const d=await r.json();tc={token:d.access_token,expiry:now+(d.expires_in||3600)*1000};return tc.token;}}catch(e){}
  }
  return null;
}
export default async function handler(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  if(req.method==="OPTIONS")return res.status(200).end();
  const{booking,bl,container,debug}=req.query;
  const ref=(booking||bl||container||"").trim();
  if(!ref)return res.status(400).json({error:"booking requerido"});
  const url=ZIM_BASE+"/"+encodeURIComponent(ref);
  const att=[];
  try{const token=await getToken();if(token){const r=await fetch(url,{headers:{"Authorization":"Bearer "+token,"Ocp-Apim-Subscription-Key":ZIM_SUB_KEY,"Accept":"application/json"}});const txt=await r.text();att.push({m:"b+s",s:r.status,b:txt.slice(0,200)});if(r.ok){const d=JSON.parse(txt);if(debug==="1")return res.json({ok:true,method:"bearer+sub",data:d});return res.json(d);}}}catch(e){att.push({m:"b+s",err:e.message});}
  try{const r=await fetch(url,{headers:{"Ocp-Apim-Subscription-Key":ZIM_SUB_KEY,"Accept":"application/json"}});const txt=await r.text();att.push({m:"sub",s:r.status,b:txt.slice(0,200)});if(r.ok){const d=JSON.parse(txt);if(debug==="1")return res.json({ok:true,method:"sub_only",data:d});return res.json(d);}}catch(e){att.push({m:"sub",err:e.message});}
  return res.status(401).json({error:"ZIM auth fallida",attempts:att});
}
