import { useState, useEffect } from "react";

const APP_USER = "Exportrak";
const APP_PASS = "Exportrak";

// ── Supabase ──────────────────────────────────────────────
const SB_URL = "https://utbbsvmulfvsrwolyvcf.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV0YmJzdm11bGZ2c3J3b2x5dmNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0OTQ0NTMsImV4cCI6MjA4ODA3MDQ1M30.gC5Jm5YJ7BxIhIuxF4ko0fFinUT7dX8Ihy2Eu2xRlXw";
const SB_H = { apikey:SB_KEY, Authorization:`Bearer ${SB_KEY}`, "Content-Type":"application/json" };
const MAERSK_KEY = "Xy0X5yHT2R1x2iogcjz4XO0ha3SGD8Gi";
const MAERSK_SECRET = "f8RGUdGlKp5QWlky";
const HLAG_CLIENT_ID = "c9f9c96f-81f5-417d-975b-3a1b139ba612";
const HLAG_CLIENT_SECRET = "3OZ8Q~pE5uMOKhWuj24c.WdB05nv6P2DW1bB8b-Z";



async function sbGet(path) {
  try { const r=await fetch(`${SB_URL}${path}`,{headers:SB_H}); return r.ok?r.json():null; } catch{return null;}
}
async function sbUpsert(table, data) {
  try { await fetch(`${SB_URL}/rest/v1/${table}`,{method:"POST",headers:{...SB_H,Prefer:"resolution=merge-duplicates"},body:JSON.stringify(data)}); } catch{}
}

async function trackMaersk(booking) {
  try {
    // Call through our Vercel proxy to avoid CORS
    const res = await fetch(`/api/maersk-track?booking=${encodeURIComponent(booking)}`);
    if(!res.ok) return { eta:null, arrived:false, events:[], error:`HTTP ${res.status}` };
    const data = await res.json();
    if(data.error) return { eta:null, arrived:false, events:[], error:data.error };
    const events = data.events || [];
    let eta = data.eta ? data.eta.split("T")[0] : null;
    let arrived = false;
    for(const ev of events) {
      if(ev.eventType==="EQUIPMENT"&&(ev.activityTypeCode==="DISC"||ev.activityTypeCode==="GOUT")) arrived=true;
      if(!eta&&ev.eventType==="TRANSPORT"&&ev.eventClassifierCode==="EST"&&ev.transportCall?.modeOfTransport==="VESSEL") {
        const d = ev.eventDateTime?.split("T")[0];
        if(d) eta=d;
      }
    }
    return { eta, arrived, events, error:null };
  } catch(e) {
    return { eta:null, arrived:false, events:[], error:e.message };
  }
}

async function trackCma(booking) {
  try {
    const res = await fetch(`/api/cma-track?booking=${encodeURIComponent(booking)}`);
    if(!res.ok) return { eta:null, arrived:false, events:[], error:`HTTP ${res.status}` };
    const data = await res.json();
    if(data.error) return { eta:null, arrived:false, events:[], error:data.error };
    const events = data.events || [];
    let eta = null;
    let arrived = false;
    for(const ev of events) {
      if(ev.eventTypeCode==="ARRI" || ev.eventTypeCode==="DISC") arrived=true;
      if(ev.eventTypeCode==="ARRI" && ev.plannedDate) eta=ev.plannedDate.substring(0,10);
    }
    return { eta, arrived, events };
  } catch(e) {
    return { eta:null, arrived:false, events:[], error:e.message };
  }
}

// Mapa destinos → código UN (para encontrar el ARRI en destino correcto)
const DESTINO_UN_MAP = {
  "casablanca":"MACAS","marruecos":"MACAS","hamburg":"DEHAM","hamburgo":"DEHAM",
  "rotterdam":"NLRTM","barcelona":"ESBCN","valencia":"ESVLC","genova":"ITGOA",
  "génova":"ITGOA","felixstowe":"GBFXT","antwerp":"BEANR","amberes":"BEANR",
  "istanbul":"TRIST","estambul":"TRIST","singapore":"SGSIN","singapur":"SGSIN",
  "shanghai":"CNSHA","ningbo":"CNNBO","algeciras":"ESALG","le havre":"FRLEH",
  "havre":"FRLEH","tanger":"MAPTM","tánger":"MAPTM",
};
function destinoToUN(destino=""){
  const l=destino.toLowerCase();
  for(const [k,v] of Object.entries(DESTINO_UN_MAP)) if(l.includes(k)) return v;
  return null;
}

async function trackHlag(booking, destino="") {
  try {
    const res = await fetch(`/api/hlag-track?booking=${encodeURIComponent(booking)}`);
    if(!res.ok) return { eta:null, arrived:false, events:[], buque:null, fechaSalida:null, error:`HTTP ${res.status}` };
    const data = await res.json();
    if(data.error) return { eta:null, arrived:false, events:[], buque:null, fechaSalida:null, error:data.error };
    // La API devuelve el array directamente (DCSA v2)
    const events = Array.isArray(data) ? data : (data.events || []);
    const sorted = [...events].sort((a,b)=>new Date(a.eventDateTime)-new Date(b.eventDateTime));

    let eta = null, arrived = false, buque = null, fechaSalida = null;
    const unDest = destinoToUN(destino);

    // Buque y fecha salida: DEPA desde Buenos Aires (ARBUE)
    const depEvent = sorted.find(e=>
      e.eventType==="TRANSPORT" && e.transportEventTypeCode==="DEPA" &&
      e.transportCall?.UNLocationCode==="ARBUE"
    );
    if(depEvent){
      buque = depEvent.transportCall?.vessel?.vesselName || null;
      fechaSalida = depEvent.eventDateTime?.split("T")[0] || null;
    }

    // ETA: ARRI en destino (PLN). Primero intenta con UN code, luego último ARRI PLN
    let arriEvent = unDest
      ? sorted.find(e=>e.eventType==="TRANSPORT"&&e.transportEventTypeCode==="ARRI"&&e.transportCall?.UNLocationCode===unDest)
      : null;
    if(!arriEvent){
      const arris = sorted.filter(e=>e.eventType==="TRANSPORT"&&e.transportEventTypeCode==="ARRI"&&e.eventClassifierCode==="PLN");
      arriEvent = arris[arris.length-1];
    }
    if(arriEvent) eta = arriEvent.eventDateTime?.split("T")[0] || null;

    // ¿Ya llegó? EQUIPMENT DISC o GTIN en destino con ACT
    arrived = sorted.some(e=>
      e.eventType==="EQUIPMENT" && e.eventClassifierCode==="ACT" &&
      (e.equipmentEventTypeCode==="DISC" || e.equipmentEventTypeCode==="GTOT") &&
      (unDest ? e.transportCall?.UNLocationCode===unDest : true)
    );

    return { eta, arrived, events, buque, fechaSalida, error:null };
  } catch(e) {
    return { eta:null, arrived:false, events:[], buque:null, fechaSalida:null, error:e.message };
  }
}

async function sbDelete(table, id) {
  try { await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`,{method:"DELETE",headers:SB_H}); } catch{}
}

// Mappers app ↔ DB
const shipToDb=(s,co)=>{
  const lines=s.productosEmbarque||[];
  const totalKg=lines.reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
  const fl=lines[0]||{};
  return {
    id:s.id,company_id:co,cliente:s.cliente,email_cliente:s.emailCliente,destino:s.destino,
    producto:fl.contratoProducto||s.producto||'',
    volumen:s.volumen,
    cantidad_kg:totalKg||(parseFloat(s.cantidadKg)||null),
    contrato_id:fl.contratoId||s.contratoId||null,
    contrato_producto:fl.contratoProducto||s.contratoProducto||'',
    proforma:s.proforma,factura_num:s.facturaNum,vencimiento_type:s.vencimientoType,
    estado_docs:s.estadoDocs,fecha_salida:s.fechaSalida,fecha_estimada:s.fechaEstimada,
    naviera:s.naviera,buque:s.buque,bl:s.bl,status:s.status,notas:s.notas,
    productos_embarque_json:JSON.stringify(lines)
  };
};
const dbToShip=r=>{
  let pe=[];
  if(r.productos_embarque_json){try{pe=JSON.parse(r.productos_embarque_json);}catch{}}
  if(!pe.length){
    pe=[{id:`pe-${r.id}`,contratoId:r.contrato_id||'',contratoProducto:r.contrato_producto||r.producto||'',cantidadKg:r.cantidad_kg||''}];
  }
  const totalKg=pe.reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
  const productoDisplay=pe.map(l=>l.contratoProducto||'').filter(Boolean).join(' / ')||r.producto||'';
  return {
    id:r.id,cliente:r.cliente,emailCliente:r.email_cliente,destino:r.destino,
    producto:productoDisplay,volumen:r.volumen,cantidadKg:totalKg||r.cantidad_kg,
    contratoId:pe[0]?.contratoId||r.contrato_id,contratoProducto:pe[0]?.contratoProducto||r.contrato_producto||'',
    proforma:r.proforma,facturaNum:r.factura_num,vencimientoType:r.vencimiento_type,
    estadoDocs:r.estado_docs,fechaSalida:r.fecha_salida,fechaEstimada:r.fecha_estimada,
    naviera:r.naviera,buque:r.buque,bl:r.bl,status:r.status,notas:r.notas,
    productosEmbarque:pe
  };
};
const contToDb=(c,co)=>({id:c.id,company_id:co,numero:c.numero,cliente:c.cliente,lote:c.lote,fecha_contrato:c.fechaContrato,incoterm:c.incoterm,puerto_destino:c.puertoDestino,destino_final:c.destinoFinal,notas:c.notas,productos_json:JSON.stringify(c.productos||[])});
const dbToCont=r=>({id:r.id,numero:r.numero,cliente:r.cliente,lote:r.lote,fechaContrato:r.fecha_contrato,incoterm:r.incoterm,puertoDestino:r.puerto_destino,destinoFinal:r.destino_final,notas:r.notas,productos:r.productos_json?JSON.parse(r.productos_json):[]});
const clientToDb=(c,co)=>({id:c.id,company_id:co,nombre:c.nombre,email:c.email,email2:c.email2,telefono:c.telefono,direccion:c.direccion,productos:JSON.stringify(c.productos||[])});
const dbToClient=r=>{let prods=[];try{prods=JSON.parse(r.productos||"[]");}catch(e){}return{id:r.id,nombre:r.nombre,email:r.email,email2:r.email2,telefono:r.telefono,direccion:r.direccion,productos:Array.isArray(prods)?prods:[]};};
const coToDb=c=>({id:c.id,name:c.name,sender_email:c.senderEmail||"",direccion:c.direccion||"",cuit:c.cuit||"",email:c.email||"",web:c.web||""});
const dbToCo=r=>({id:r.id,name:r.name,senderEmail:r.sender_email,direccion:r.direccion,cuit:r.cuit,email:r.email,web:r.web||""});
// ─────────────────────────────────────────────────────────

function LoginScreen({onLogin,dark}) {
  const [user,setUser]=useState("");
  const [pass,setPass]=useState("");
  const [error,setError]=useState("");
  const [showPass,setShowPass]=useState(false);

  function handleLogin(){
    if(user===APP_USER&&pass===APP_PASS){
      sessionStorage.setItem("exportrak-auth","1");
      onLogin();
    } else {
      setError("Usuario o contraseña incorrectos.");
      setTimeout(()=>setError(""),3000);
    }
  }

  const bg  = dark?"#080D14":"#F1F5F9";
  const bg2 = dark?"#0D1520":"#FFFFFF";
  const bdr = dark?"#1A2D45":"#CBD5E1";
  const txt = dark?"#C8D8E8":"#1E293B";
  const txt3= dark?"#4A6A8A":"#94A3B8";

  return (
    <div style={{minHeight:"100vh",background:bg,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Barlow',sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@400;600&display=swap');*{box-sizing:border-box;margin:0;padding:0}input{outline:none}button{cursor:pointer;border:none;font-family:inherit}`}</style>
      <div style={{background:bg2,border:`1px solid ${bdr}`,borderRadius:20,width:380,padding:40,animation:"fadeUp 0.3s ease",boxShadow:dark?"0 24px 60px rgba(0,0,0,0.5)":"0 24px 60px rgba(0,0,0,0.1)"}}>
        <style>{`@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}`}</style>
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{width:56,height:56,borderRadius:16,background:"linear-gradient(135deg,#0EA5E9,#0369A1)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 14px"}}>⛵</div>
          <div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:26,color:dark?"#E2EEF8":"#0F172A",letterSpacing:2}}>EXPORTRAK</div>
          <div style={{fontSize:10,color:txt3,letterSpacing:3,marginTop:4}}>SISTEMA DE SEGUIMIENTO</div>
        </div>
        <div style={{marginBottom:16}}>
          <label style={{fontSize:9,color:txt3,letterSpacing:2,display:"block",marginBottom:6}}>USUARIO</label>
          <input value={user} onChange={e=>setUser(e.target.value)} onKeyDown={e=>e.key==="Enter"&&document.getElementById("pass-input").focus()} placeholder="Usuario" style={{width:"100%",background:bg,border:`1px solid ${error?"#EF4444":bdr}`,borderRadius:10,padding:"11px 14px",color:txt,fontSize:13}}/>
        </div>
        <div style={{marginBottom:24,position:"relative"}}>
          <label style={{fontSize:9,color:txt3,letterSpacing:2,display:"block",marginBottom:6}}>CONTRASEÑA</label>
          <input id="pass-input" type={showPass?"text":"password"} value={pass} onChange={e=>setPass(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()} placeholder="Contraseña" style={{width:"100%",background:bg,border:`1px solid ${error?"#EF4444":bdr}`,borderRadius:10,padding:"11px 40px 11px 14px",color:txt,fontSize:13}}/>
          <button onClick={()=>setShowPass(v=>!v)} style={{position:"absolute",right:12,top:30,color:txt3,fontSize:15,background:"none",padding:2}}>{showPass?"🙈":"👁"}</button>
        </div>
        {error&&<div style={{marginBottom:16,padding:"9px 12px",borderRadius:8,background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",color:"#EF4444",fontSize:12,textAlign:"center",animation:"shake 0.4s ease"}}>{error}</div>}
        <button onClick={handleLogin} style={{width:"100%",padding:"13px",borderRadius:10,fontSize:13,fontWeight:700,letterSpacing:1,background:"linear-gradient(135deg,#0EA5E9,#0369A1)",color:"#fff",boxShadow:"0 4px 20px rgba(14,165,233,0.35)",transition:"opacity 0.2s"}} onMouseOver={e=>e.target.style.opacity="0.88"} onMouseOut={e=>e.target.style.opacity="1"}>INGRESAR</button>
        <div style={{textAlign:"center",marginTop:20,fontSize:10,color:txt3}}>EXPORTRAK · Sistema privado de uso interno</div>
      </div>
    </div>
  );
}


const STATUS_CONFIG = {
  "En Preparación": { color: "#F59E0B", bg: "rgba(245,158,11,0.12)", icon: "◐" },
  "En Tránsito":    { color: "#3B82F6", bg: "rgba(59,130,246,0.12)",  icon: "◎" },
  "Entregado":      { color: "#10B981", bg: "rgba(16,185,129,0.12)",  icon: "◉" },
};
const DOC_COLORS = {
  "Pendiente":        { color: "#F59E0B", bg: "rgba(245,158,11,0.12)" },
  "Falta BL":         { color: "#EF4444", bg: "rgba(239,68,68,0.12)" },
  "Coordinar Retiro": { color: "#10B981", bg: "rgba(16,185,129,0.12)" },
  "Enviado":          { color: "#A855F7", bg: "rgba(168,85,247,0.12)" },
};
const NAVIERAS  = ["CMA CGM","COSCO Shipping","Evergreen","Hamburg Süd","Hapag-Lloyd","Maersk","MSC","OOCL","ONE","Yang Ming"];
const INCOTERMS = ["EXW","FCA","FAS","FOB","CFR","CIF","CPT","CIP","DAP","DPU","DDP"];
const VENC_OPT  = ["100% CAD","100% a 15 días","100% a 20 días","100% a 30 días"];

const INIT_COMPANIES = [
  { id:"co1", name:"AMERICA PAMPA AGROINDUSTRIAL SA", senderEmail:"matiasmoreno@americapampa.com", direccion:"Pellegrini 77 (6237) - América - Buenos Aires - Argentina", cuit:"30-71030179-0", email:"info@americapampa.com", web:"www.americapampa.com" },
  { id:"co2", name:"PELAYO AGRONOMIA SA", senderEmail:"mmoreno@pelayosa.com.ar", direccion:"Av. Juan La Gioiosa 255 (6360) General Pico - La Pampa - Argentina", cuit:"30-70920121-9", email:"pelayoagronomia@pelayosa.com.ar", web:"www.pelayosa.com.ar" }
];
const INIT_SHIPMENTS = [
  { id:"EXP-0091", cliente:"Pacific Foods Ltd.", emailCliente:"pacific@example.com", destino:"Rotterdam", producto:"Texturizado de Soja", volumen:"8", cantidadKg:25000, contratoId:"CONT-001", proforma:"PRO-001", facturaNum:"FAC-2026-001", vencimientoType:"100% a 30 días", estadoDocs:"Pendiente", fechaSalida:"2026-01-15", fechaEstimada:"2026-04-05", naviera:"Maersk", buque:"MSC Beatrice", bl:"MAEU-782341", status:"En Tránsito", notas:"", productosEmbarque:[{id:"pe1",contratoId:"CONT-001",contratoProducto:"Texturizado de Soja",cantidadKg:25000}] },
  { id:"EXP-0092", cliente:"Grupo Andino S.A.", emailCliente:"andino@example.com", destino:"Shanghai", producto:"Harina de Soja", volumen:"5", cantidadKg:18000, contratoId:"CONT-002", proforma:"PRO-002", facturaNum:"FAC-2026-002", vencimientoType:"100% CAD", estadoDocs:"Falta BL", fechaSalida:"2026-02-10", fechaEstimada:"2026-04-20", naviera:"COSCO Shipping", buque:"COSCO Harmony", bl:"COSU-114892", status:"En Tránsito", notas:"", productosEmbarque:[{id:"pe1",contratoId:"CONT-002",contratoProducto:"Harina de Soja",cantidadKg:18000}] },
  { id:"EXP-0090", cliente:"Pacific Foods Ltd.", emailCliente:"pacific@example.com", destino:"Valencia", producto:"Texturizado de Soja", volumen:"6", cantidadKg:20000, contratoId:"CONT-001", proforma:"PRO-003", facturaNum:"FAC-2026-003", vencimientoType:"100% a 15 días", estadoDocs:"Enviado", fechaSalida:"2025-12-01", fechaEstimada:"2026-02-10", naviera:"MSC", buque:"MSC Francesca", bl:"MSCU-990123", status:"Entregado", notas:"", productosEmbarque:[{id:"pe1",contratoId:"CONT-001",contratoProducto:"Texturizado de Soja",cantidadKg:20000}] },
];
const INIT_CONTRACTS = [
  { id:"CONT-001", numero:"CONT-001", cliente:"Pacific Foods Ltd.", lote:"LOTE-A-2026", fechaContrato:"2026-01-10", incoterm:"FOB", puertoDestino:"Rotterdam", destinoFinal:"Países Bajos", notas:"", productos:[{id:"p1",nombre:"Texturizado de Soja",cantidadKg:80000,precioUsdTon:450,entregas:[{id:"e1",cantidadKg:80000,fecha:"2026-06-30"}]}] },
  { id:"CONT-002", numero:"CONT-002", cliente:"Grupo Andino S.A.", lote:"LOTE-B-2026", fechaContrato:"2026-01-20", incoterm:"CIF", puertoDestino:"Shanghai", destinoFinal:"China", notas:"", productos:[{id:"p1",nombre:"Harina de Soja",cantidadKg:18000,precioUsdTon:380,entregas:[{id:"e1",cantidadKg:18000,fecha:"2026-05-30"}]}] },
];
const INIT_CLIENTS = [
  { id:"cli1", nombre:"Pacific Foods Ltd.", email:"pacific@example.com", email2:"", telefono:"+1 555 0101", direccion:"" },
  { id:"cli2", nombre:"Grupo Andino S.A.", email:"andino@example.com", email2:"", telefono:"+54 11 5555 0102", direccion:"" },
];
const EMPTY_PE = ()=>({id:`pe-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,contratoId:"",contratoProducto:"",cantidadKg:""});
const EMPTY_FORM = { cliente:"", emailCliente:"", destino:"", producto:"", volumen:"", cantidadKg:"", contratoId:"", proforma:"", facturaNum:"", vencimientoType:"100% CAD", estadoDocs:"Pendiente", fechaSalida:"", fechaEstimada:"", naviera:NAVIERAS[0], buque:"", bl:"", notas:"", productosEmbarque:[{id:"pe1",contratoId:"",contratoProducto:"",cantidadKg:""}] };
const EMPTY_CONTRACT = { numero:"", cliente:"", lote:"", fechaContrato:"", incoterm:"FOB", puertoDestino:"", destinoFinal:"", notas:"", productos:[{id:"p1",nombre:"",cantidadKg:"",precioUsdTon:"",entregas:[{id:"e1",cantidadKg:"",fecha:""}]}] };
const EMPTY_CLIENT = { nombre:"", email:"", email2:"", telefono:"", direccion:"", productos:[] };

// ── Tariff Positions ──────────────────────────────────────
const TARIFF_POSITIONS_BY_CO={
  co1:[
    {code:"1208.10.00.000J",desc:"Harina de Soja"},
    {code:"2106.10.00.000Z",desc:"Texturizado de Soja"},
  ],
  co2:[
    {code:"1202.42.00.190Z",desc:"Crudo/runner entero"},
    {code:"1202.42.00.290E",desc:"Crudo/runner partido"},
    {code:"1202.42.00.319D",desc:"Blancheado entero"},
    {code:"1202.42.00.329G",desc:"Blancheado partido"},
  ],
};
const getTariffPositions=(coId)=>TARIFF_POSITIONS_BY_CO[coId]||TARIFF_POSITIONS_BY_CO.co2;
const bankToDb=(b,co)=>({id:b.id,company_id:co,banco:b.banco||"",correspondent:b.datosBancarios||""});
const dbToBank=r=>{const legacy=[r.nombre&&("Beneficiario: "+r.nombre),r.beneficiario&&("Beneficiario: "+r.beneficiario),r.cuit&&("CUIT: "+r.cuit),r.direccion&&("Dirección: "+r.direccion),r.swift&&("SWIFT: "+r.swift),r.iban&&("IBAN: "+r.iban),r.cuenta&&("Cuenta: "+r.cuenta),r.correspondent].filter(Boolean).join("\n");return {id:r.id,banco:r.banco||"",datosBancarios:r.datosBancarios||r.correspondent||legacy||""};};
const pfToDb=(p,co)=>({id:p.id,company_id:co,numero:p.numero,fecha:p.fecha,contrato_id:p.contratoId||null,cliente:p.cliente,data_json:JSON.stringify(p)});
const dbToPf=r=>{try{const d=JSON.parse(r.data_json);return{...d,id:r.id};}catch{return null;}};
const EMPTY_BANK={id:"",banco:"",datosBancarios:""};
const EMPTY_PF_LINE=()=>({id:`l-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,descripcionEn:"Argentinean Peanuts",empaque:"In Polypropylene bags x 25Kg. with Tags",cantidadBolsones:"",pesoBolson:25,precio:"",lote:"",pa:"",containerNum:"",precinto:""});
const EMPTY_PF=()=>({id:"",numero:"",fecha:new Date().toISOString().split("T")[0],po:"-",contratoId:"",contratosIds:[],cliente:"",emailCliente:"",direccionCliente:"",vat:"",contacto:"",incoterm:"FOB",puertoDestino:"",puertoOrigen:"BUENOS AIRES / ARGENTINA",origen:"ARGENTINA",shipmentDesc:"",paymentTerms:"100% CAD",bankAccountId:"",freightRate:"",freightContainers:"",seguro:"",netWeight:"",grossWeight:"",conditions:"Peanuts Crop 2025\nQuality in accordance with EU-Food-regulations",lineas:[],notas:""});

function getDias(eta) {
  if (!eta) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  return Math.round((new Date(eta+"T00:00") - now) / 86400000);
}
function getAlerta(dias, status) {
  if (status==="Entregado"||dias===null||dias<0) return null;
  if (dias<=5)  return { color:"#EF4444", bg:"rgba(239,68,68,0.15)",  nivel:"rojo",  emoji:"🔴" };
  if (dias<=10) return { color:"#F59E0B", bg:"rgba(245,158,11,0.15)", nivel:"amari", emoji:"🟡" };
  return null;
}
function calcStatus(s, e) {
  const now = new Date(); now.setHours(0,0,0,0);
  if (!s) return "En Preparación";
  const sal = new Date(s+"T00:00");
  if (now < sal) return "En Preparación";
  if (e) { const ll=new Date(e+"T00:00"); if(now<ll) return "En Tránsito"; return "Entregado"; }
  return "En Tránsito";
}
function calcVencFecha(eta, tipo) {
  if (!eta||!tipo) return null;
  const d = new Date(eta+"T00:00");
  const days = tipo==="100% CAD"?0:tipo==="100% a 15 días"?15:tipo==="100% a 20 días"?20:30;
  d.setDate(d.getDate()+days);
  return d.toISOString().split("T")[0];
}
// ── Proforma Invoice + Packing List print ─────────────────
function printProformaDoc(pf, company, bank) {
  const n4=(v,d=2)=>v?parseFloat(v).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:4}):"—";
  const fd=s=>s?new Date(s+"T00:00").toLocaleDateString("en-GB",{day:"2-digit",month:"2-digit",year:"numeric"}):"—";
  const netKg=pf.lineas.reduce((a,l)=>a+(parseFloat(l.cantidadBolsones)||0)*(parseFloat(l.pesoBolson)||25),0);
  const grossKg=pf.grossWeight?parseFloat(pf.grossWeight):Math.round(netKg*1.002);
  const freightTotal=(parseFloat(pf.freightContainers)||0)*(parseFloat(pf.freightRate)||0);
  const seguroTotal=parseFloat(pf.seguro)||0;
  const lineTotal=pf.lineas.reduce((a,l)=>{const kg=(parseFloat(l.cantidadBolsones)||0)*(parseFloat(l.pesoBolson)||25);return a+kg*(parseFloat(l.precio)||0);},0);
  const grandTotal=lineTotal+freightTotal+seguroTotal;
  const totalBolsones=pf.lineas.reduce((a,l)=>a+(parseInt(l.cantidadBolsones)||0),0);
  const bankText=bank&&(bank.datosBancarios||bank.correspondent||bank.banco)?[bank.datosBancarios,bank.correspondent,bank.banco&&("Banco: "+bank.banco)].filter(Boolean)[0]:"—";
  const pfLines=pf.lineas.map(l=>{
    const kg=(parseFloat(l.cantidadBolsones)||0)*(parseFloat(l.pesoBolson)||25);
    const tot=kg*(parseFloat(l.precio)||0);
    return`<tr><td class="num">${kg.toLocaleString()}</td><td><b>${l.descripcionEn||"—"}</b></td><td class="num">${n4(l.precio,4)}</td><td class="num">${n4(tot)}</td></tr><tr class="sub"><td></td><td><span>${l.cantidadBolsones||"—"} bags · ${l.empaque||""}</span><br><span>Batch/Lote: <b>${l.lote||"—"}</b> &nbsp;·&nbsp; P.A ${l.pa||"—"}</span></td><td></td><td></td></tr>`;
  }).join("");
  const plRows=pf.lineas.map(l=>{
    const kg=(parseFloat(l.cantidadBolsones)||0)*(parseFloat(l.pesoBolson)||25);
    return`<tr><td>${l.containerNum||"—"}</td><td>${l.precinto||"—"}</td><td class="num">${kg.toLocaleString()} Kg.</td><td class="num">${l.cantidadBolsones||"—"}</td><td><b>${l.descripcionEn||"—"}</b><br><small>${l.empaque||""}</small></td><td>${l.lote||"—"}</td></tr>`;
  }).join("");
  const paList=getTariffPositions(company?.id).map(t=>`<div class="pa-item"><b>${t.code}</b> — ${t.desc}</div>`).join("");
  const css=`<style>@page{size:A4;margin:14mm 12mm}*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;font-size:10px;color:#1a1a1a}.page{width:100%;page-break-after:always;position:relative;overflow:visible}.page:last-child{page-break-after:auto}.co{font-size:15px;font-weight:800;color:#0369A1}.hdg{font-size:14px;font-weight:800;color:#0369A1;letter-spacing:.5px}.hrow{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:none;padding-bottom:0;margin-bottom:0}.header-divider{width:100%;height:2px;background:linear-gradient(90deg,#16a34a 0%,#0369A1 60%,#e2e8f0 100%);margin:6px 0 10px;border-radius:1px}.header-logo{height:54px;object-fit:contain}.hdoc{font-size:13px;font-weight:800;color:#1e3a5f;letter-spacing:.3px}.lbl{font-size:7.5px;font-weight:700;color:#64748B;letter-spacing:1px;text-transform:uppercase;margin-bottom:1px}.val{font-size:10px;color:#0F172A}.ig{display:grid;gap:0;border:1px solid #CBD5E1;border-radius:4px;overflow:hidden;margin-bottom:9px}.ic{padding:5px 8px;border-right:1px solid #CBD5E1;border-bottom:1px solid #CBD5E1}.pa-box{float:right;width:195px;margin:0 0 8px 10px;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:4px;padding:6px 9px}.pa-title{font-size:7.5px;font-weight:700;color:#1D4ED8;letter-spacing:1px;margin-bottom:4px;text-transform:uppercase}.pa-item{font-size:8.5px;padding:2px 0;border-bottom:1px solid #DBEAFE;color:#1E3A5F}table{width:100%;border-collapse:collapse;font-size:9.5px}thead th{background:#0369A1;color:#fff;padding:5px 7px;text-align:left;font-weight:700;font-size:8px}td{padding:4px 7px;border-bottom:1px solid #E2E8F0;vertical-align:top}.sub td{background:#F8FAFC;font-size:8.5px;color:#475569;border-bottom:1px solid #F1F5F9}.num{text-align:right;font-weight:600}.totrow td{font-weight:700;background:#EFF6FF!important;border-top:2px solid #BFDBFE;font-size:11px}.bank{background:#F8FAFC;border:1px solid #E2E8F0;border-radius:4px;padding:5px 8px;white-space:pre-line;font-size:7.5px;line-height:1.45;margin-bottom:5px}.footer{margin-top:10px;font-size:7.5px;color:#94A3B8;border-top:1px solid #E2E8F0;padding-top:5px;display:flex;justify-content:space-between}.co2-doc *{background:transparent!important;background-color:transparent!important}.co2-doc thead th{background:rgba(3,105,161,0.90)!important;color:#fff!important}.co2-doc .totrow td{background:rgba(255,255,255,0.50)!important;font-weight:700}.co2-doc .footer{display:none!important}.co2-doc .page{padding-top:46mm!important;padding-bottom:20mm!important}.co2-doc .hdoc{margin-left:28mm!important}</style>`;
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Proforma ${pf.numero}</title>${css}</head><body class="${company.id==='co2'?'co2-doc':''}">
${company.id==="co2"?'<img src="data:image/jpeg;base64,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fPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2vfafhPHa77Bte+0/Clw2VfPPTsZZ1RHjtd9g2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" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:-1;pointer-events:none;object-fit:fill;opacity:0.88;" />':''}
<div class="page" style="position:relative;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
    <div class="hdoc">PROFORMA INVOICE / FACTURA PROFORMA</div>
    <div style="text-align:right"><span class="lbl">N°: </span><b style="font-size:14px;color:#0369A1">${pf.numero}</b> &nbsp;&nbsp; <span class="lbl">Date/Fecha: </span><b>${fd(pf.fecha)}</b></div>
  </div>
  <div style="margin-bottom:10px">
    <div class="ig" style="grid-template-columns:1fr 1fr">
      <div class="ic"><div class="lbl">Purchase Order / Orden de Compra</div><div class="val">${pf.po||"—"}</div></div>
      <div class="ic"><div class="lbl">Contrato / Contract</div><div class="val"><b>${pf.contratoId||"—"}</b></div></div>
      <div class="ic"><div class="lbl">Comprador / Buyer</div><div class="val"><b>${pf.cliente}</b></div></div>
      <div class="ic"><div class="lbl">VAT / EORI</div><div class="val">${pf.vat||"—"}</div></div>
      <div class="ic" style="border-bottom:none"><div class="lbl">Dirección / Address</div><div class="val">${pf.direccionCliente||pf.emailCliente||"—"}</div></div>
      <div class="ic" style="border-bottom:none"><div class="lbl">Contacto / Contact</div><div class="val">${pf.contacto||"—"}</div></div>
    </div>
  </div>
  <table style="margin-bottom:9px"><thead><tr><th style="width:95px">Cantidad Kg. / Quantity Kg.</th><th>Descripción / Description Of Goods</th><th style="width:95px;text-align:right">Precio Unit. / Unit Price (USD)</th><th style="width:105px;text-align:right">Precio Total / Total Price (USD)</th></tr></thead>
  <tbody>${pfLines}
  ${pf.freightRate&&pf.freightContainers?`<tr style="background:#FFFBEB"><td class="num">${pf.freightContainers}</td><td><b>Freight Rate &nbsp;/&nbsp; B/L - TELEX RELEASE</b></td><td class="num">${n4(pf.freightRate)}</td><td class="num">${n4(freightTotal)}</td></tr>`:""}
  ${seguroTotal>0?`<tr style="background:#F0FDF4"><td class="num">1</td><td><b>Insurance / Seguro</b></td><td class="num">—</td><td class="num">${n4(seguroTotal)}</td></tr>`:""}
  ${pf.conditions?`<tr><td></td><td><div class="lbl" style="margin-bottom:2px">Conditions/Condiciones:</div>${pf.conditions.split("\n").map(c=>`<div style="font-size:9px;color:#475569">${c}</div>`).join("")}</td><td></td><td></td></tr>`:""}
  <tr class="totrow"><td></td><td><b>TOTAL &nbsp;&nbsp;&nbsp; ${pf.incoterm} &nbsp;&nbsp;&nbsp; Port/Puerto: ${pf.puertoDestino||"—"}</b></td><td></td><td class="num">USD ${n4(grandTotal)}</td></tr>
  </tbody></table>
  <div class="ig" style="grid-template-columns:1fr 1fr 1fr;margin-bottom:9px">
    <div class="ic"><div class="lbl">Shipment / Embarque</div><div class="val">${pf.shipmentDesc||"—"}</div></div>
    <div class="ic"><div class="lbl">Net Weight / Peso Neto</div><div class="val"><b>${(pf.netWeight?parseFloat(pf.netWeight):netKg).toLocaleString()} Kg.</b></div></div>
    <div class="ic"><div class="lbl">Gross Weight / Peso Bruto</div><div class="val"><b>${grossKg.toLocaleString()} Kg.</b></div></div>
    <div class="ic" style="border-bottom:none"><div class="lbl">Dest. Port / Puerto Destino</div><div class="val">${pf.puertoDestino||"—"}</div></div>
    <div class="ic" style="border-bottom:none;border-right:none;grid-column:span 2"><div class="lbl">Port of Origin / Puerto de Origen</div><div class="val">${pf.puertoOrigen}</div></div>
  </div>
  <div style="margin-bottom:8px"><div class="lbl" style="margin-bottom:3px">Payment Terms / Condiciones de Pago:</div><div class="val"><b>${pf.paymentTerms}</b></div></div>
  <div style="margin-bottom:8px"><div class="lbl" style="margin-bottom:3px">Bank Details / Detalle Bancario:</div><div class="bank">${bankText}</div></div>
  ${pf.notas?`<div style="margin-bottom:8px"><div class="lbl" style="margin-bottom:2px">Notas:</div><div style="font-size:9px;color:#475569">${pf.notas}</div></div>`:""}
  ${company.id!=="co2"?'<div class="footer"><span>${company.name} · ${company.direccion||""} · CUIT: ${company.cuit||""}</span><span>${company.email||""}${company.web?" · "+company.web:""}</span></div>':''}
</div>
<div class="page" style="position:relative;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
    <div class="hdoc">PACKING LIST / LISTA DE EMPAQUE</div>
    <div style="text-align:right"><span class="lbl">Proforma N°: </span><b style="font-size:12px;color:#0369A1">${pf.numero}</b> &nbsp;&nbsp; <span class="lbl">Fecha: </span><b>${fd(pf.fecha)}</b></div>
  </div>
  <div class="ig" style="grid-template-columns:1fr 1fr;margin-bottom:9px">
    <div class="ic"><div class="lbl">Proforma Invoice N°</div><div class="val"><b>${pf.numero}</b></div></div>
    <div class="ic"><div class="lbl">Fecha / Date</div><div class="val">${fd(pf.fecha)}</div></div>
    <div class="ic"><div class="lbl">Contrato / Contract</div><div class="val">${pf.contratoId||"—"}</div></div>
    <div class="ic"><div class="lbl">Factura / Invoice N°</div><div class="val">—</div></div>
    <div class="ic"><div class="lbl">Exportador / Exporter</div><div class="val">${company.name}</div></div>
    <div class="ic" style="border-bottom:none"><div class="lbl">CUIT</div><div class="val">${company.cuit||"—"}</div></div>
    <div class="ic" style="border-bottom:none;border-right:none;grid-column:span 2"><div class="lbl">Dirección</div><div class="val">${company.direccion||"—"}</div></div>
  </div>
  <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:4px;padding:7px 10px;margin-bottom:9px;font-size:9.5px"><div class="lbl" style="margin-bottom:2px">Consignee:</div><b>${pf.cliente}</b>${pf.direccionCliente?`<br>${pf.direccionCliente}`:""}${pf.vat?`<br>${pf.vat}`:""}</div>
  <table style="margin-bottom:9px"><thead><tr><th>Container N°</th><th>Precinto / Seal</th><th style="text-align:right">Cantidad / Qty (Kg.)</th><th style="text-align:right">Bolsones / Bags</th><th>Descripción / Description of Goods</th><th>Batch / Lote N°</th></tr></thead>
  <tbody>${plRows}<tr class="totrow"><td></td><td><b>TOTALES / TOTALS</b></td><td class="num">${netKg.toLocaleString()} Kg.</td><td class="num">${totalBolsones.toLocaleString()}</td><td></td><td></td></tr></tbody></table>

  <div class="ig" style="grid-template-columns:1fr 1fr 1fr;margin-top:9px;margin-bottom:9px">
    <div class="ic"><div class="lbl">Shipment / Embarque</div><div class="val">${pf.shipmentDesc||"—"}</div></div>
    <div class="ic"><div class="lbl">Net Weight / Peso Neto</div><div class="val"><b>${(pf.netWeight?parseFloat(pf.netWeight):netKg).toLocaleString()} Kg.</b></div></div>
    <div class="ic"><div class="lbl">Gross Weight / Peso Bruto</div><div class="val"><b>${grossKg.toLocaleString()} Kg.</b></div></div>
    <div class="ic" style="border-bottom:none"><div class="lbl">Dest. Port / Puerto Destino</div><div class="val">${pf.puertoDestino||"—"}</div></div>
    <div class="ic" style="border-bottom:none;border-right:none;grid-column:span 2"><div class="lbl">Port of Origin / Puerto de Origen</div><div class="val">${pf.puertoOrigen}</div></div>
  </div>
  <div style="display:flex;justify-content:flex-end;margin-top:60px"><div style="text-align:center;width:200px;border-top:1px solid #1a1a1a;padding-top:4px;font-size:9px;font-weight:700">FIRMA EXPORTADOR / EXPORTER SIGNATURE</div></div>
  ${company.id!=="co2"?'<div class="footer"><span>${company.name} · ${company.direccion||""} · CUIT: ${company.cuit||""}</span><span>${company.email||""}${company.web?" · "+company.web:""}</span></div>':''}
</div>
</body></html>`;
  const w=window.open("","_blank","width=960,height=760");
  w.document.write(html);w.document.close();setTimeout(()=>w.print(),600);
}
function fmtDate(s) { return s?new Date(s+"T00:00").toLocaleDateString("es-AR"):"—"; }

// ── Delivery coverage tracker ──────────────────────────────
// Returns each entrega with coverage status, applying shipment kg chronologically.
function calcEntregasStatus(product, shipments, contractId) {
  // Gather all shipment lines for this product+contract
  const shipLines = [];
  shipments.forEach(s => {
    const lines = (s.productosEmbarque||[]).filter(l =>
      l.contratoId === contractId &&
      (l.contratoProducto||'').trim().toLowerCase() === (product.nombre||'').trim().toLowerCase()
    );
    const kg = lines.reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0), 0);
    if (kg > 0) shipLines.push({...s, kgEste: kg});
  });
  // Sort shipments by departure date ascending (nulls last)
  shipLines.sort((a,b)=>{
    if (!a.fechaSalida && !b.fechaSalida) return 0;
    if (!a.fechaSalida) return 1;
    if (!b.fechaSalida) return -1;
    return new Date(a.fechaSalida)-new Date(b.fechaSalida);
  });
  const totalKgShipped = shipLines.reduce((a,s)=>a+s.kgEste, 0);

  // Sort entregas by date ascending (nulls last)
  const entregas = [...(product.entregas||[])].sort((a,b)=>{
    if (!a.fecha && !b.fecha) return 0;
    if (!a.fecha) return 1;
    if (!b.fecha) return -1;
    return new Date(a.fecha)-new Date(b.fecha);
  });

  const today = new Date(); today.setHours(0,0,0,0);
  let remaining = totalKgShipped;
  return entregas.map((ent, i) => {
    const kgEnt = parseFloat(ent.cantidadKg)||0;
    const covered = Math.min(remaining, kgEnt);
    remaining = Math.max(0, remaining - kgEnt);
    let status = covered >= kgEnt ? 'cubierta' : covered > 0 ? 'parcial' : 'pendiente';
    let diasRestantes = null;
    if (ent.fecha) {
      const d = new Date(ent.fecha+'T00:00');
      diasRestantes = Math.round((d - today)/86400000);
    }
    return { ...ent, idx: i+1, kgCubierto: covered, kgPendiente: Math.max(0,kgEnt-covered), status, diasRestantes };
  });
}

function openMailto(mailtoUrl) {
  window.open(mailtoUrl, "_blank", "noopener,noreferrer");
}

function emailShipment(s, senderEmail, companyId) {
  // CC por empresa
  const cc = companyId==="co2"
    ? "imilanesio@pelayosa.com.ar"
    : "ivanmilanesio@americapampa.com";

  // Productos desde productosEmbarque (campo real del objeto)
  const lines = Array.isArray(s.productosEmbarque) && s.productosEmbarque.length>0
    ? s.productosEmbarque
    : [{contratoProducto: s.producto||s.contratoProducto||"—", cantidadKg: s.cantidadKg||""}];

  const prodStr = lines
    .map(p=>`  • ${p.contratoProducto||"—"}: ${p.cantidadKg?Number(p.cantidadKg).toLocaleString():"—"} Kg.`)
    .join("\n");

  const totalKg = lines.reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
  const totalKgStr = totalKg>0 ? totalKg.toLocaleString() : (s.cantidadKg||"—");

  const notasLine = s.notas ? `\n\nNotes / Notas:\n${s.notas}` : "";

  const subj = encodeURIComponent(`Shipment Notice – Proforma ${s.proforma||""} – ${s.cliente||""}`);
  const body = encodeURIComponent(
`Dear ${s.cliente},

We are pleased to inform you that your shipment has been scheduled according to the contractual and booking confirmation.

Shipment Details:
- Proforma Invoice: ${s.proforma||"—"}
- Product / Producto:
${prodStr}
- Total Kg.: ${totalKgStr} Kg.
- Booking / Reserva: ${s.bl||"—"}
- Shipping Line / Naviera: ${s.naviera||"—"}
- ETD (Departure): ${s.fechaSalida||"—"}
- ETA (Arrival): ${s.fechaEstimada||"—"}${notasLine}

Please keep this information for your records and feel free to contact us if you need further documentation or assistance.

Best regards,
${senderEmail||""}`
  );

  openMailto(`mailto:${s.emailCliente||""}?cc=${encodeURIComponent(cc)}&subject=${subj}&body=${body}`);
}
function emailVencimiento(s, vf, senderEmail) {
  const subj=encodeURIComponent("Invoice Due Notice");
  const body=encodeURIComponent(`Dear Customer,\n\nWe kindly remind you that the following invoice is approaching its due date.\n\nTransaction Details:\n- Proforma Invoice: ${s.proforma||"—"}\n- Contract: ${s.contratoId||"—"}\n- Booking: ${s.bl||"—"}\n- Invoice: ${s.facturaNum||"—"}\n- Due Date: ${vf||"—"}\n\nPlease note that the banking details for payment are those specified in the corresponding Export Invoice.\n\nWe appreciate your prompt attention to this matter and remain at your disposal for any questions.\n\nBest regards,`);
  openMailto(`mailto:${s.emailCliente||""}?subject=${subj}&body=${body}`);
}
function JourneyBar({ s }) {
  const dias=getDias(s.fechaEstimada), alerta=getAlerta(dias,s.status);
  const tc=alerta?.nivel==="rojo"?"#EF4444":alerta?.nivel==="amari"?"#F59E0B":"#3B82F6";
  if (!s.fechaSalida||!s.fechaEstimada) return <div style={{height:6,background:"var(--bdr)",borderRadius:3}}/>;
  const sal=new Date(s.fechaSalida+"T00:00").getTime(), ll=new Date(s.fechaEstimada+"T00:00").getTime();
  const now=new Date(); now.setHours(0,0,0,0);
  const total=ll-sal, pct=s.status==="Entregado"?100:total>0?Math.min(99,Math.max(2,Math.round(((now.getTime()-sal)/total)*100))):0;
  return (
    <div>
      <div style={{position:"relative",height:18,margin:"4px 0"}}>
        <div style={{position:"absolute",inset:"6px 0",background:"var(--bdr)",borderRadius:3}}/>
        <div style={{position:"absolute",left:0,top:6,height:6,width:`${pct}%`,borderRadius:3,background:`linear-gradient(90deg,${tc}80,${tc})`,transition:"width 0.8s"}}/>
        <div style={{position:"absolute",left:0,top:"50%",transform:"translate(-50%,-50%)",width:9,height:9,borderRadius:"50%",background:"#10B981",border:"2px solid var(--bg)",boxShadow:"0 0 6px rgba(16,185,129,0.5)",zIndex:3}}/>
        {pct<97&&<div style={{position:"absolute",left:`calc(${pct}% - 10px)`,top:"50%",transform:"translateY(-55%) scaleX(-1)",fontSize:16,lineHeight:1,filter:`drop-shadow(0 0 4px ${tc})`,zIndex:4,transition:"left 0.8s ease"}}>🚢</div>}
        <div style={{position:"absolute",right:0,top:"50%",transform:"translate(50%,-50%)",width:9,height:9,borderRadius:"50%",background:pct===100?"#10B981":"var(--bdr)",border:`2px solid ${pct===100?"#10B981":"var(--bdr)"}`,boxShadow:pct===100?"0 0 8px rgba(16,185,129,0.6)":"none",zIndex:3}}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--txt3)"}}>
        <span>{s.fechaSalida}</span><span style={{color:tc,fontWeight:700,fontSize:12}}>{s.status==="Entregado"?"✓ Llegó":dias!==null&&dias>=0?dias+"d restantes":"—"}</span><span>{s.fechaEstimada}</span>
      </div>
    </div>
  );
}

function AlertBanner({shipments}) {
  const alerts=shipments.map(s=>({...s,alerta:getAlerta(getDias(s.fechaEstimada),s.status)})).filter(s=>s.alerta).sort((a,b)=>new Date(a.fechaEstimada+"T00:00")-new Date(b.fechaEstimada+"T00:00"));
  if (!alerts.length) return null;
  return <div style={{display:"flex",flexDirection:"column",gap:6}}>{alerts.map(s=>(
    <div key={s.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 14px",borderRadius:8,background:s.alerta.bg,border:`1px solid ${s.alerta.color}30`}}>
      <span style={{fontSize:14}}>{s.alerta.emoji}</span>
      <span style={{fontSize:10,color:s.alerta.color,fontWeight:700}}>{s.proforma||s.id}</span>
      <span style={{fontSize:10,color:"var(--txt2)"}}>{s.cliente}</span>
      <span style={{fontSize:10,color:"var(--txt3)",flex:1}}>→ {s.destino}</span>
      <span style={{fontSize:10,fontWeight:700,color:s.alerta.color,whiteSpace:"nowrap"}}>{getDias(s.fechaEstimada)>0?`${getDias(s.fechaEstimada)} días`:"¡HOY!"}</span>
    </div>
  ))}</div>;
}

function DetailPanel({s,onClose,onEdit,onDelete,senderEmail,activeCo}) {
  const cfg=STATUS_CONFIG[s.status]||STATUS_CONFIG["En Preparación"];
  const alerta=getAlerta(getDias(s.fechaEstimada),s.status);
  const dc=DOC_COLORS[s.estadoDocs]||DOC_COLORS["Pendiente"];
  const vf=calcVencFecha(s.fechaEstimada,s.vencimientoType);
  const dv=getDias(vf);
  const lines=s.productosEmbarque||[];
  const totalKg=lines.reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
  return (
    <div style={{padding:20,height:"100%",overflowY:"auto"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
        <div>
          <div style={{fontFamily:"'Daytona Condensed','Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:"var(--hdg)"}}>{s.proforma||s.id}</div>
          <div style={{fontSize:9,color:"var(--txt3)",marginTop:2}}>{s.id} · {s.cliente}</div>
        </div>
        <div style={{display:"flex",gap:5,flexWrap:"wrap",justifyContent:"flex-end"}}>
          <button onClick={()=>emailShipment(s,senderEmail,activeCo)} style={{color:"#10B981",fontSize:11,padding:"4px 8px",borderRadius:6,border:"1px solid rgba(16,185,129,0.3)",background:"rgba(16,185,129,0.08)",whiteSpace:"nowrap"}}>✉ Notice</button>
          <button onClick={()=>onEdit(s)} style={{color:"#0EA5E9",fontSize:13,padding:"4px 8px",borderRadius:6,border:"1px solid rgba(14,165,233,0.3)",background:"rgba(14,165,233,0.08)"}}>✎</button>
          <button onClick={()=>onDelete(s.id)} style={{color:"#EF4444",fontSize:13,padding:"4px 8px",borderRadius:6,border:"1px solid rgba(239,68,68,0.3)",background:"rgba(239,68,68,0.08)"}}>✕</button>
          <button onClick={onClose} style={{color:"var(--txt3)",fontSize:16}}>✕</button>
        </div>
      </div>
      <div style={{marginBottom:12}}><JourneyBar s={s}/></div>

      {/* Multi-product lines */}
      {lines.length>0&&(
        <div style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"10px 12px",marginBottom:12}}>
          <div style={{fontSize:7,color:"var(--txt3)",letterSpacing:2,marginBottom:8}}>PRODUCTOS DEL EMBARQUE</div>
          {lines.map((l,i)=>(
            <div key={l.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:i<lines.length-1?"1px solid var(--bdr2)":"none"}}>
              <div>
                <div style={{fontSize:11,color:"var(--hdg)",fontWeight:600}}>{l.contratoProducto||"—"}</div>
                {l.contratoId&&<div style={{fontSize:9,color:"var(--txt3)",marginTop:1}}>Contrato: {l.contratoId}</div>}
              </div>
              <div style={{fontSize:12,color:"#3B82F6",fontWeight:700}}>{parseFloat(l.cantidadKg||0).toLocaleString()} kg</div>
            </div>
          ))}
          {lines.length>1&&(
            <div style={{display:"flex",justifyContent:"space-between",marginTop:7,paddingTop:7,borderTop:"1px solid var(--bdr)"}}>
              <span style={{fontSize:9,color:"var(--txt3)",letterSpacing:1}}>TOTAL</span>
              <span style={{fontSize:13,color:"#0EA5E9",fontWeight:800}}>{totalKg.toLocaleString()} kg</span>
            </div>
          )}
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:12}}>
        {[
          {l:"DESTINO",v:s.destino},
          {l:"CONTENEDORES",v:s.volumen||"—"},
          {l:"SALIDA",v:fmtDate(s.fechaSalida)},{l:"ETA",v:fmtDate(s.fechaEstimada),hi:alerta?.color},
          {l:"ESTADO",v:`${cfg.icon} ${s.status}`,hi:cfg.color},{l:"DOCS",v:s.estadoDocs||"Pendiente",hi:dc.color},
          {l:"FACTURA N°",v:s.facturaNum||"—"},{l:"VENCIMIENTO",v:s.vencimientoType||"—"},
          {l:"FECHA VENC.",v:fmtDate(vf),hi:dv!==null&&dv<=10&&dv>=0?"#EF4444":undefined},
          {l:"EMAIL",v:s.emailCliente||"—"},
        ].map(item=>(
          <div key={item.l} style={{background:"var(--bg3)",borderRadius:7,padding:"8px 11px"}}>
            <div style={{fontSize:7,color:"var(--txt3)",letterSpacing:2,marginBottom:3}}>{item.l}</div>
            <div style={{fontSize:11,color:item.hi||"var(--txt)",fontWeight:item.hi?700:400,wordBreak:"break-all"}}>{item.v}</div>
          </div>
        ))}
      </div>
      <div style={{background:"var(--bg3)",borderRadius:7,padding:"9px 11px",marginBottom:7}}>
        <div style={{fontSize:7,color:"var(--txt3)",letterSpacing:2,marginBottom:3}}>TRANSPORTE</div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              <div style={{fontSize:11,color:"var(--txt2)"}}>{s.naviera}{s.buque?` · ${s.buque}`:""}{s.bl?` · Reserva: ${s.bl}`:""}</div>
            </div>
      </div>
      {dv!==null&&dv<=10&&dv>=0&&(
        <div style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:7,padding:"9px 11px",marginBottom:7}}>
          <div style={{fontSize:10,color:"#EF4444",fontWeight:700}}>⚠ Factura próxima a vencer: {fmtDate(vf)} ({dv<=0?"VENCIDO":`${dv} días`})</div>
          <button onClick={()=>emailVencimiento(s,vf,senderEmail)} style={{marginTop:6,color:"#EF4444",fontSize:10,padding:"3px 10px",borderRadius:5,border:"1px solid rgba(239,68,68,0.4)",background:"rgba(239,68,68,0.08)",fontFamily:"inherit"}}>✉ Enviar Invoice Due Notice</button>
        </div>
      )}
      {s.notas&&<div style={{background:"var(--bg3)",borderRadius:7,padding:"9px 11px"}}>
        <div style={{fontSize:7,color:"var(--txt3)",letterSpacing:2,marginBottom:3}}>NOTAS</div>
        <div style={{fontSize:11,color:"var(--txt2)",lineHeight:1.5}}>{s.notas}</div>
      </div>}
    </div>
  );
}
function VencimientosTab({shipments, senderEmail, onMarkCobrado}) {
  const rows=shipments.filter(s=>s.facturaNum&&s.vencimientoType&&s.fechaEstimada).map(s=>{
    const vf=calcVencFecha(s.fechaEstimada,s.vencimientoType);
    return {...s,vf,dv:getDias(vf)};
  }).sort((a,b)=>new Date(a.vf+"T00:00")-new Date(b.vf+"T00:00"));
  const pendientes=rows.filter(r=>r.estadoCobro!=="cobrado");
  const cobradas=rows.filter(r=>r.estadoCobro==="cobrado");
  const urgentes=pendientes.filter(r=>r.dv!==null&&r.dv<=10);
  return (
    <div style={{padding:24,maxWidth:1100,margin:"0 auto"}}>
      <div style={{fontFamily:"'Daytona Condensed','Barlow Condensed',sans-serif",fontWeight:800,fontSize:22,color:"var(--hdg)",marginBottom:4,letterSpacing:1}}>VENCIMIENTOS</div>
      <div style={{fontSize:10,color:"var(--txt3)",letterSpacing:2,marginBottom:20}}>FACTURAS ORDENADAS POR FECHA DE VENCIMIENTO</div>
      {urgentes.length>0&&(
        <div style={{background:"rgba(239,68,68,0.07)",border:"1px solid rgba(239,68,68,0.25)",borderRadius:12,padding:16,marginBottom:20}}>
          <div style={{fontSize:10,color:"#EF4444",fontWeight:700,letterSpacing:2,marginBottom:10}}>⚠ PRÓXIMOS A VENCER ({urgentes.length})</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {urgentes.map(r=>(
              <div key={r.id} style={{display:"flex",alignItems:"center",gap:12,background:"var(--bg2)",borderRadius:8,padding:"10px 14px"}}>
                <span style={{fontSize:18}}>{r.dv<=0?"🔴":r.dv<=5?"🔴":"🟡"}</span>
                <div style={{flex:1}}>
                  <span style={{fontSize:12,color:"#EF4444",fontWeight:700}}>{r.facturaNum}</span>
                  <span style={{fontSize:11,color:"var(--txt2)",marginLeft:10}}>{r.cliente}</span>
                  <span style={{fontSize:10,color:"var(--txt3)",marginLeft:8}}>{r.proforma||r.id}</span>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:12,color:"#EF4444",fontWeight:700}}>{fmtDate(r.vf)}</div>
                  <div style={{fontSize:9,color:"var(--txt3)"}}>{r.dv<=0?"VENCIDO":`${r.dv} días`}</div>
                </div>
                <div style={{display:"flex",gap:6}}><button onClick={()=>emailVencimiento(r,r.vf,senderEmail)} style={{color:"#EF4444",fontSize:11,padding:"5px 10px",borderRadius:6,border:"1px solid rgba(239,68,68,0.4)",background:"rgba(239,68,68,0.08)",whiteSpace:"nowrap",fontFamily:"inherit"}}>✉ Aviso</button><button onClick={()=>onMarkCobrado(r.id)} style={{color:"#10B981",fontSize:11,padding:"5px 10px",borderRadius:6,border:"1px solid rgba(16,185,129,0.4)",background:"rgba(16,185,129,0.08)",whiteSpace:"nowrap",fontFamily:"inherit",fontWeight:700}}>✓ Cobrado</button></div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,overflow:"hidden"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr style={{borderBottom:"1px solid var(--bdr)",background:"var(--bg3)"}}>
            {["FACTURA N°","PROFORMA","CLIENTE","DESTINO","TIPO VENCIMIENTO","ETA","FECHA VENC.","DÍAS","ESTADO","ACCIÓN"].map(h=>(
              <th key={h} style={{padding:"9px 12px",textAlign:"left",fontSize:9,color:"var(--txt3)",letterSpacing:2,fontWeight:700,whiteSpace:"nowrap"}}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {pendientes.map((r,i)=>{
              const color=r.dv===null?"var(--txt2)":r.dv<=0?"#EF4444":r.dv<=5?"#EF4444":r.dv<=10?"#F59E0B":"var(--txt2)";
              const cfg=STATUS_CONFIG[r.status]||STATUS_CONFIG["En Preparación"];
              return (
                <tr key={r.id} style={{borderBottom:"1px solid var(--bdr2)",animation:`fadeUp 0.25s ease ${i*0.03}s both`}}>
                  <td style={{padding:"10px 12px",fontSize:12,color:"#0EA5E9",fontWeight:700}}>{r.facturaNum}</td>
                  <td style={{padding:"10px 12px",fontSize:11,color:"var(--txt)"}}>{r.proforma||r.id}</td>
                  <td style={{padding:"10px 12px",fontSize:12,color:"var(--txt)"}}>{r.cliente}</td>
                  <td style={{padding:"10px 12px",fontSize:11,color:"var(--txt2)"}}>{r.destino}</td>
                  <td style={{padding:"10px 12px"}}><span style={{background:"rgba(59,130,246,0.1)",color:"#3B82F6",padding:"3px 9px",borderRadius:100,fontSize:10,fontWeight:700}}>{r.vencimientoType}</span></td>
                  <td style={{padding:"10px 12px",fontSize:11,color:"var(--txt2)"}}>{fmtDate(r.fechaEstimada)}</td>
                  <td style={{padding:"10px 12px",fontSize:12,color,fontWeight:700}}>{fmtDate(r.vf)}</td>
                  <td style={{padding:"10px 12px",fontSize:12,color,fontWeight:700}}>{r.dv===null?"—":r.dv<=0?"VENCIDO":`${r.dv}d`}</td>
                  <td style={{padding:"10px 12px"}}><span style={{background:cfg.bg,color:cfg.color,padding:"3px 8px",borderRadius:100,fontSize:9,fontWeight:700}}>{cfg.icon} {r.status}</span></td>
                  <td style={{padding:"10px 12px"}}><div style={{display:"flex",gap:5}}><button onClick={()=>emailVencimiento(r,r.vf,senderEmail)} style={{color:"#F59E0B",fontSize:11,padding:"4px 9px",borderRadius:6,border:"1px solid rgba(245,158,11,0.3)",background:"rgba(245,158,11,0.08)",fontFamily:"inherit",whiteSpace:"nowrap"}}>✉ Aviso</button><button onClick={()=>onMarkCobrado(r.id)} style={{color:"#10B981",fontSize:11,padding:"4px 9px",borderRadius:6,border:"1px solid rgba(16,185,129,0.4)",background:"rgba(16,185,129,0.08)",fontFamily:"inherit",whiteSpace:"nowrap",fontWeight:700}}>✓ Cobrado</button></div></td>
                </tr>
              );
            })}
            {rows.length===0&&<tr><td colSpan={10} style={{padding:40,textAlign:"center",color:"var(--txt3)",fontSize:13}}>No hay facturas registradas con vencimiento</td></tr>}
          </tbody>
        </table>
      </div>
      {cobradas.length>0&&(
        <div style={{marginTop:16}}>
          <div style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,fontWeight:700,marginBottom:8}}>✓ COBRADAS ({cobradas.length})</div>
          <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <tbody>{cobradas.map(r=>(
                <tr key={r.id} style={{borderBottom:"1px solid var(--bdr)",opacity:0.5}}>
                  <td style={{padding:"8px 12px",fontSize:11,color:"var(--txt3)"}}>{r.facturaNum}</td>
                  <td style={{padding:"8px 12px",fontSize:11,color:"var(--txt3)"}}>{r.proforma||"—"}</td>
                  <td style={{padding:"8px 12px",fontSize:11,color:"var(--txt3)"}}>{r.cliente}</td>
                  <td style={{padding:"8px 12px",fontSize:11,color:"var(--txt3)"}}>{fmtDate(r.vf)}</td>
                  <td style={{padding:"8px 12px"}}><span style={{fontSize:10,color:"#10B981",fontWeight:700}}>✓ COBRADO</span></td>
                  <td style={{padding:"8px 12px"}}><button onClick={()=>onMarkCobrado(r.id)} style={{color:"var(--txt3)",fontSize:10,padding:"3px 7px",borderRadius:5,border:"1px solid var(--bdr)",background:"transparent",fontFamily:"inherit"}}>Deshacer</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ClientesTab({clients,onSave,onDelete,activeCo}) {
  const [showForm,setShowForm]=useState(false);
  const [form,setForm]=useState(EMPTY_CLIENT);
  const [editId,setEditId]=useState(null);
  const [search,setSearch]=useState("");
  const filtered=clients.filter(c=>{const q=search.toLowerCase();return !q||c.nombre.toLowerCase().includes(q)||(c.email||"").toLowerCase().includes(q);});
  function openNew(){setForm(EMPTY_CLIENT);setEditId(null);setShowForm(true);}
  function openEdit(c){setForm({...c});setEditId(c.id);setShowForm(true);}
  function save(){if(!form.nombre)return;const id=editId||`cli-${Date.now()}`;onSave({...form,id},editId);setShowForm(false);}
  return (
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 92px)"}}>
      <div style={{padding:"10px 20px",borderBottom:"1px solid var(--bdr)",display:"flex",gap:10,alignItems:"center"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar cliente o email..." style={{flex:1,background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:8,padding:"7px 14px",color:"var(--txt)",fontSize:11,fontFamily:"inherit"}}/>
        <button onClick={openNew} style={{background:"linear-gradient(135deg,#0EA5E9,#0369A1)",color:"#fff",padding:"7px 16px",borderRadius:8,fontSize:11,fontFamily:"inherit",fontWeight:700,whiteSpace:"nowrap"}}>+ NUEVO CLIENTE</button>
      </div>
      <div style={{flex:1,overflowY:"auto"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr style={{borderBottom:"1px solid var(--bdr)"}}>
            {["CLIENTE","EMAIL","2DO EMAIL","TELÉFONO","DIRECCIÓN",""].map(h=><th key={h} style={{padding:"9px 16px",textAlign:"left",fontSize:9,color:"var(--txt3)",letterSpacing:2,fontWeight:700}}>{h}</th>)}
          </tr></thead>
          <tbody>
            {filtered.map((c,i)=>(
              <tr key={c.id} className="srow" style={{borderBottom:"1px solid var(--bdr2)",animation:`fadeUp 0.25s ease ${i*0.03}s both`}}>
                <td style={{padding:"12px 16px",fontSize:13,color:"var(--hdg)",fontWeight:600}}>{c.nombre}</td>
                <td style={{padding:"12px 16px",fontSize:12,color:"#0EA5E9"}}>{c.email||"—"}</td>
                <td style={{padding:"12px 16px",fontSize:12,color:"var(--txt2)"}}>{c.email2||"—"}</td>
                <td style={{padding:"12px 16px",fontSize:12,color:"var(--txt2)"}}>{c.telefono||"—"}</td>
                <td style={{padding:"12px 16px",fontSize:12,color:"var(--txt2)"}}>{c.direccion||"—"}</td>
                <td style={{padding:"12px 10px",whiteSpace:"nowrap"}}>
                  <button onClick={()=>openEdit(c)} style={{color:"var(--txt3)",fontSize:14,marginRight:6}}>✎</button>
                  <button onClick={()=>onDelete(c.id)} style={{color:"#EF4444",fontSize:14}}>✕</button>
                </td>
              </tr>
            ))}
            {filtered.length===0&&<tr><td colSpan={4} style={{padding:40,textAlign:"center",color:"var(--txt3)",fontSize:13}}>No hay clientes registrados</td></tr>}
          </tbody>
        </table>
      </div>
      {showForm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(3,6,12,0.88)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}}>
          <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:16,width:460,padding:30,animation:"fadeUp 0.22s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:22}}>
              <div style={{fontFamily:"'Daytona Condensed','Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:"var(--hdg)"}}>{editId?"EDITAR CLIENTE":"NUEVO CLIENTE"}</div>
              <button onClick={()=>setShowForm(false)} style={{color:"var(--txt3)",fontSize:20}}>✕</button>
            </div>
            {[{label:"Nombre *",key:"nombre"},{label:"Email",key:"email",type:"email"},{label:"2do Email",key:"email2",type:"email"},{label:"Teléfono",key:"telefono"},{label:"Dirección",key:"direccion"}].map(f=>(
              <div key={f.key} style={{marginBottom:13}}>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>{f.label.toUpperCase()}</label>
                <input type={f.type||"text"} value={form[f.key]||""} onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))} style={{width:"100%",background:"var(--bg)",border:"1px solid var(--bdr)",borderRadius:8,padding:"9px 12px",color:"var(--txt)",fontSize:12,fontFamily:"inherit"}}/>
              </div>
            ))}
            {activeCo==="co1"&&(
              <div style={{marginBottom:13}}>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>PRODUCTOS DEL CLIENTE</label>
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {(form.productos||[]).map((p,i)=>(
                    <div key={i} style={{display:"flex",gap:6,alignItems:"center"}}>
                      <input value={p} onChange={e=>{const arr=[...(form.productos||[])];arr[i]=e.target.value;setForm(x=>({...x,productos:arr}));}} style={{flex:1,background:"var(--bg)",border:"1px solid var(--bdr)",borderRadius:7,padding:"7px 10px",color:"var(--txt)",fontSize:11,fontFamily:"inherit"}} placeholder="Nombre del producto"/>
                      <button onClick={()=>setForm(x=>({...x,productos:(x.productos||[]).filter((_,j)=>j!==i)}))} style={{color:"#EF4444",background:"none",border:"none",fontSize:16,cursor:"pointer",padding:"0 4px"}}>✕</button>
                    </div>
                  ))}
                  <button onClick={()=>setForm(x=>({...x,productos:[...(x.productos||[]),""]}))} style={{alignSelf:"flex-start",fontSize:10,padding:"5px 12px",borderRadius:6,border:"1px dashed var(--bdr)",background:"transparent",color:"var(--txt3)",cursor:"pointer",fontFamily:"inherit"}}>+ Agregar producto</button>
                </div>
              </div>
            )}
            <div style={{display:"flex",gap:12,marginTop:18,justifyContent:"flex-end"}}>
              <button onClick={()=>setShowForm(false)} style={{padding:"9px 20px",borderRadius:8,fontSize:12,fontFamily:"inherit",color:"var(--txt3)",background:"transparent",border:"1px solid var(--bdr)"}}>CANCELAR</button>
              <button onClick={save} style={{padding:"9px 20px",borderRadius:8,fontSize:12,fontFamily:"inherit",background:"linear-gradient(135deg,#0EA5E9,#0369A1)",color:"#fff",fontWeight:700}}>GUARDAR</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function ContratosTab({contracts,shipments,getKgEmb,onNew,onEdit,onDelete}) {
  const [selected,setSelected]=useState(null);
  const [search,setSearch]=useState("");
  const filtered=contracts.filter(c=>{
    const q=search.toLowerCase();
    const prods=(c.productos||[]).map(p=>p.nombre||'').join(' ');
    return !q||c.numero.toLowerCase().includes(q)||c.cliente.toLowerCase().includes(q)||prods.toLowerCase().includes(q);
  });
  function getEstado(c){
    const emb=getKgEmb(c.id),kg=(c.productos||[]).reduce((a,p)=>a+(parseFloat(p.cantidadKg)||0),0);
    if(kg===0)return{label:"Sin datos",color:"var(--txt3)",pct:0};
    const pct=Math.min(100,Math.round((emb/kg)*100));
    if(pct>=100)return{label:"Completado",color:"#10B981",pct:100};
    if(pct>0)return{label:"En Curso",color:"#3B82F6",pct};
    return{label:"Pendiente",color:"#F59E0B",pct:0};
  }
  const sel=selected?contracts.find(c=>c.id===selected):null;
  // Pre-compute shipped kg per contract+product pair for efficient lookup
  const kgEmbMap={};
  shipments.forEach(s=>{
    (s.productosEmbarque||[]).forEach(l=>{
      if(!l.contratoId)return;
      const key=`${l.contratoId}||${l.contratoProducto||''}`;
      kgEmbMap[key]=(kgEmbMap[key]||0)+(parseFloat(l.cantidadKg)||0);
    });
  });
  return (
    <div style={{display:"flex",height:"calc(100vh - 92px)"}}>
      <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
        <div style={{padding:"10px 20px",borderBottom:"1px solid var(--bdr)",display:"flex",gap:10,alignItems:"center"}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar contrato, cliente, producto..." style={{flex:1,background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:8,padding:"7px 14px",color:"var(--txt)",fontSize:11,fontFamily:"inherit"}}/>
          <button onClick={onNew} style={{background:"linear-gradient(135deg,#10B981,#059669)",color:"#fff",padding:"7px 16px",borderRadius:8,fontSize:11,fontFamily:"inherit",fontWeight:700,whiteSpace:"nowrap"}}>+ NUEVO CONTRATO</button>
        </div>
        <div style={{flex:1,overflowY:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr style={{borderBottom:"1px solid var(--bdr)"}}>
              {["CONTRATO","CLIENTE","PRODUCTOS","KG EMBARCADO","SALDO","ESTADO",""].map(h=>(
                <th key={h} style={{padding:"9px 12px",textAlign:"left",fontSize:9,color:"var(--txt3)",letterSpacing:2,fontWeight:700,whiteSpace:"nowrap"}}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {filtered.map((c,i)=>{
                const kgTotal=(c.productos||[]).reduce((a,p)=>a+(parseFloat(p.cantidadKg)||0),0);
                const kgEmb=getKgEmb(c.id);
                const estado=getEstado(c),isActive=selected===c.id;
                const prods=(c.productos||[]).filter(p=>p.nombre);
                const prodKgEmb=prods.map(p=>{
                  const ke=kgEmbMap[`${c.id}||${p.nombre}`]||0;
                  return{nombre:p.nombre,kgEmb:ke,kgSaldo:Math.max(0,(parseFloat(p.cantidadKg)||0)-ke)};
                });
                return (
                  <tr key={c.id} className="srow" onClick={()=>setSelected(isActive?null:c.id)} style={{borderBottom:"1px solid var(--bdr2)",background:isActive?"rgba(16,185,129,0.06)":"transparent",cursor:"pointer",animation:`fadeUp 0.25s ease ${i*0.04}s both`}}>
                    <td style={{padding:"10px 12px"}}><div style={{fontSize:12,color:"#10B981",fontWeight:700}}>{c.numero}</div><div style={{fontSize:9,color:"var(--txt3)",marginTop:2}}>{c.fechaContrato}</div></td>
                    <td style={{padding:"10px 12px",fontSize:12,color:"var(--txt)"}}>{c.cliente}</td>
                    <td style={{padding:"10px 12px",maxWidth:400}}>
                      {prods.length>0?(
                        <div style={{display:"flex",flexDirection:"column",gap:3}}>
                          {prods.map((p,pi)=>(
                            <div key={p.id||pi} style={{fontSize:10,color:"var(--txt2)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                              <div style={{display:"flex",alignItems:"center",gap:5,minWidth:0}}>
                                <span style={{width:5,height:5,borderRadius:"50%",background:"#10B981",flexShrink:0,display:"inline-block"}}/>
                                <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.nombre}</span>
                              </div>
                              <span style={{fontSize:10,color:"var(--hdg)",fontWeight:700,whiteSpace:"nowrap",flexShrink:0}}>{(parseFloat(p.cantidadKg)||0).toLocaleString()} kg</span>
                            </div>
                          ))}
                          {prods.length>1&&<div style={{display:"flex",justifyContent:"flex-end",borderTop:"1px solid var(--bdr2)",paddingTop:3,marginTop:1}}><span style={{fontSize:10,color:"#0EA5E9",fontWeight:800}}>Total: {kgTotal.toLocaleString()} kg</span></div>}
                        </div>
                      ):<span style={{fontSize:11,color:"var(--txt3)"}}>—</span>}
                    </td>
                    <td style={{padding:"10px 12px"}}>
                      {prodKgEmb.length>0?(
                        <div style={{display:"flex",flexDirection:"column",gap:3}}>
                          {prodKgEmb.map((p,pi)=>(
                            <div key={pi} style={{fontSize:10,color:"var(--txt2)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                              <div style={{display:"flex",alignItems:"center",gap:5,minWidth:0}}>
                                <span style={{width:5,height:5,borderRadius:"50%",background:"#3B82F6",flexShrink:0,display:"inline-block"}}/>
                                <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.nombre}</span>
                              </div>
                              <span style={{fontSize:10,color:"#3B82F6",fontWeight:700,whiteSpace:"nowrap",flexShrink:0}}>{p.kgEmb.toLocaleString()} kg</span>
                            </div>
                          ))}
                          {prodKgEmb.length>1&&<div style={{display:"flex",justifyContent:"flex-end",borderTop:"1px solid var(--bdr2)",paddingTop:3,marginTop:1}}><span style={{fontSize:10,color:"#0EA5E9",fontWeight:800}}>Total: {kgEmb.toLocaleString()} kg</span></div>}
                        </div>
                      ):<span style={{fontSize:12,color:"#3B82F6",fontWeight:700}}>{kgEmb.toLocaleString()} kg</span>}
                      <div style={{marginTop:4,height:3,background:"var(--bdr)",borderRadius:2,width:80}}><div style={{height:"100%",borderRadius:2,width:`${estado.pct}%`,background:estado.color,transition:"width 0.5s"}}/></div>
                    </td>
                    <td style={{padding:"10px 12px"}}>
                      {prodKgEmb.length>0?(
                        <div style={{display:"flex",flexDirection:"column",gap:3}}>
                          {prodKgEmb.map((p,pi)=>(
                            <div key={pi} style={{fontSize:10,color:"var(--txt2)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                              <div style={{display:"flex",alignItems:"center",gap:5,minWidth:0}}>
                                <span style={{width:5,height:5,borderRadius:"50%",background:p.kgSaldo>0?"#F59E0B":"#10B981",flexShrink:0,display:"inline-block"}}/>
                                <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.nombre}</span>
                              </div>
                              <span style={{fontSize:10,color:p.kgSaldo>0?"#F59E0B":"#10B981",fontWeight:700,whiteSpace:"nowrap",flexShrink:0}}>{p.kgSaldo.toLocaleString()} kg</span>
                            </div>
                          ))}
                          {prodKgEmb.length>1&&<div style={{display:"flex",justifyContent:"flex-end",borderTop:"1px solid var(--bdr2)",paddingTop:3,marginTop:1}}><span style={{fontSize:10,color:"#0EA5E9",fontWeight:800}}>Total: {prodKgEmb.reduce((a,p)=>a+p.kgSaldo,0).toLocaleString()} kg</span></div>}
                        </div>
                      ):<span style={{fontSize:12,color:Math.max(0,kgTotal-kgEmb)>0?"#F59E0B":"#10B981",fontWeight:700}}>{Math.max(0,kgTotal-kgEmb).toLocaleString()} kg</span>}
                    </td>
                    <td style={{padding:"10px 12px"}}><span style={{background:`rgba(${estado.color==="#10B981"?"16,185,129":estado.color==="#3B82F6"?"59,130,246":"245,158,11"},0.12)`,color:estado.color,padding:"3px 9px",borderRadius:100,fontSize:10,fontWeight:700}}>{estado.label}</span></td>
                    <td style={{padding:"10px 8px"}}><button onClick={e=>{e.stopPropagation();onEdit(c);}} style={{color:"var(--txt3)",fontSize:13,padding:"2px 6px"}}>✎</button></td>
                  </tr>
                );
              })}
              {filtered.length===0&&<tr><td colSpan={7} style={{padding:40,textAlign:"center",color:"var(--txt3)",fontSize:13}}>No hay contratos</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {sel&&(()=>{
        const embs=shipments.filter(s=>s.contratoId===sel.id||(s.productosEmbarque||[]).some(l=>l.contratoId===sel.id));
        const kgEmbTotal=shipments.reduce((tot,s)=>{
          const ls=s.productosEmbarque||[];
          return tot+ls.filter(l=>l.contratoId===sel.id).reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
        },0);
        const productos=sel.productos||[];
        const kgContTotal=productos.reduce((a,p)=>a+(parseFloat(p.cantidadKg)||0),0);
        const pctTotal=kgContTotal>0?Math.min(100,Math.round((kgEmbTotal/kgContTotal)*100)):0;
        const saldoTotal=Math.max(0,kgContTotal-kgEmbTotal);
        return (
          <div style={{width:390,borderLeft:"1px solid var(--bdr)",background:"var(--bg2)",overflowY:"auto",animation:"slideIn 0.28s ease",flexShrink:0}}>
            <div style={{padding:18}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                <div>
                  <div style={{fontFamily:"'Daytona Condensed','Barlow Condensed',sans-serif",fontWeight:800,fontSize:17,color:"#10B981"}}>{sel.numero}</div>
                  <div style={{fontSize:10,color:"var(--txt3)",marginTop:2}}>{sel.cliente}</div>
                </div>
                <div style={{display:"flex",gap:7,alignItems:"center"}}>
                  <button onClick={()=>onEdit(sel)} style={{color:"#0EA5E9",fontSize:13,padding:"3px 7px",borderRadius:5,border:"1px solid rgba(14,165,233,0.3)",background:"rgba(14,165,233,0.08)"}}>✎</button>
                  <button onClick={()=>{onDelete(sel.id);setSelected(null);}} style={{color:"#EF4444",fontSize:13,padding:"3px 7px",borderRadius:5,border:"1px solid rgba(239,68,68,0.3)",background:"rgba(239,68,68,0.08)"}}>🗑</button>
                  <button onClick={()=>setSelected(null)} title="Cerrar" style={{color:"var(--txt3)",fontSize:18,padding:"2px 6px",borderRadius:5,border:"1px solid var(--bdr)",background:"var(--bg3)",lineHeight:1}}>✕</button>
                </div>
              </div>
              <div style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:9,padding:12,marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                  <span style={{fontSize:9,color:"var(--txt3)",letterSpacing:1.5}}>PROGRESO TOTAL</span>
                  <span style={{fontSize:11,color:"#3B82F6",fontWeight:700}}>{pctTotal}%</span>
                </div>
                <div style={{height:7,background:"var(--bdr)",borderRadius:4}}>
                  <div style={{height:"100%",borderRadius:4,width:pctTotal+"%",background:pctTotal>=100?"#10B981":"#3B82F6",transition:"width 0.6s"}}/>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
                  <span style={{fontSize:8,color:"#3B82F6"}}>Emb: {kgEmbTotal.toLocaleString()} kg</span>
                  <span style={{fontSize:8,color:saldoTotal>0?"#F59E0B":"#10B981"}}>Saldo: {saldoTotal.toLocaleString()} kg</span>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:10}}>
                {[{l:"LOTE",v:sel.lote||"—"},{l:"INCOTERM",v:sel.incoterm||"—"},{l:"PUERTO",v:sel.puertoDestino||"—"},{l:"DESTINO",v:sel.destinoFinal||"—"},{l:"F. CONTRATO",v:fmtDate(sel.fechaContrato)}].map(item=>(
                  <div key={item.l} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:6,padding:"7px 9px"}}>
                    <div style={{fontSize:7,color:"var(--txt3)",letterSpacing:1.5,marginBottom:2}}>{item.l}</div>
                    <div style={{fontSize:9,color:"var(--txt)"}}>{item.v}</div>
                  </div>
                ))}
              </div>
              <div style={{fontSize:8,color:"var(--txt3)",letterSpacing:2,marginBottom:8}}>PRODUCTOS ({productos.length})</div>
              {productos.map(function(prod){
                const kgEmbP=shipments.reduce((tot,s)=>{
                  const ls=s.productosEmbarque||[];
                  return tot+ls.filter(l=>l.contratoId===sel.id&&l.contratoProducto===prod.nombre).reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
                },0);
                const kgTotP=parseFloat(prod.cantidadKg)||0;
                const saldoP=Math.max(0,kgTotP-kgEmbP);
                const pctP=kgTotP>0?Math.min(100,Math.round((kgEmbP/kgTotP)*100)):0;
                return (
                  <div key={prod.id} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:10,marginBottom:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                      <div style={{fontSize:10,color:"var(--hdg)",fontWeight:700}}>{prod.nombre||"—"}</div>
                      <div style={{fontSize:9,color:"#3B82F6",fontWeight:700}}>{pctP}%</div>
                    </div>
                    <div style={{height:4,background:"var(--bdr)",borderRadius:3,marginBottom:5}}>
                      <div style={{height:"100%",borderRadius:3,width:pctP+"%",background:pctP>=100?"#10B981":"#3B82F6"}}/>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:"var(--txt3)",marginBottom:4}}>
                      <span>Emb: <b style={{color:"#3B82F6"}}>{kgEmbP.toLocaleString()} kg</b></span>
                      <span>Saldo: <b style={{color:saldoP>0?"#F59E0B":"#10B981"}}>{saldoP.toLocaleString()} kg</b></span>
                    </div>
                    {prod.precioUsdTon&&<div style={{fontSize:8,color:"var(--txt3)",marginBottom:4}}>Precio: <b style={{color:"var(--txt)"}}>USD {parseFloat(prod.precioUsdTon).toLocaleString()} ton</b></div>}
                    {(()=>{
                      const entStatus = calcEntregasStatus(prod, shipments, sel.id);
                      if (!entStatus.length) return null;
                      return (
                        <div style={{borderTop:"1px solid var(--bdr)",paddingTop:7,marginTop:5}}>
                          <div style={{fontSize:7,color:"var(--txt3)",letterSpacing:1.5,marginBottom:6}}>SEGUIMIENTO DE ENTREGAS</div>
                          {entStatus.map(ent=>{
                            const SC = ent.status==='cubierta'
                              ? {icon:"✓",color:"#10B981",bg:"rgba(16,185,129,0.1)",label:"Cubierta"}
                              : ent.status==='parcial'
                              ? {icon:"⏳",color:"#F59E0B",bg:"rgba(245,158,11,0.1)",label:"Parcial"}
                              : {icon:"⚠",color:"#EF4444",bg:"rgba(239,68,68,0.1)",label:"Pendiente"};
                            const kgEnt=parseFloat(ent.cantidadKg)||0;
                            const pct=kgEnt>0?Math.min(100,Math.round((ent.kgCubierto/kgEnt)*100)):0;
                            return (
                              <div key={ent.id} style={{background:SC.bg,border:`1px solid ${SC.color}30`,borderRadius:7,padding:"7px 9px",marginBottom:6}}>
                                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                                    <span style={{fontSize:10,color:SC.color,fontWeight:700}}>{SC.icon}</span>
                                    <span style={{fontSize:9,color:"var(--txt)",fontWeight:700}}>Entrega {ent.idx}</span>
                                    <span style={{fontSize:8,color:SC.color,background:SC.bg,padding:"1px 6px",borderRadius:100,fontWeight:700,border:`1px solid ${SC.color}40`}}>{SC.label}</span>
                                  </div>
                                  <span style={{fontSize:9,color:"#0EA5E9"}}>{ent.fecha?fmtDate(ent.fecha):"Sin fecha"}</span>
                                </div>
                                <div style={{height:3,background:"var(--bdr)",borderRadius:2,marginBottom:4}}>
                                  <div style={{height:"100%",borderRadius:2,width:pct+"%",background:SC.color,transition:"width 0.5s"}}/>
                                </div>
                                <div style={{display:"flex",justifyContent:"space-between",fontSize:8}}>
                                  <span style={{color:"var(--txt3)"}}>Comprometido: <b style={{color:"var(--txt)"}}>{kgEnt.toLocaleString()} kg</b></span>
                                  <span style={{color:"var(--txt3)"}}>Cubierto: <b style={{color:SC.color}}>{ent.kgCubierto.toLocaleString()} kg</b></span>
                                </div>
                                {ent.status!=='cubierta'&&ent.diasRestantes!==null&&(
                                  <div style={{marginTop:3,fontSize:8,color:ent.diasRestantes<0?"#EF4444":ent.diasRestantes<=7?"#F59E0B":"var(--txt3)",fontWeight:700}}>
                                    {ent.diasRestantes<0?`⚠ Vencida hace ${Math.abs(ent.diasRestantes)}d`:ent.diasRestantes===0?"⚠ Vence hoy":`${ent.diasRestantes}d restantes`}
                                    {ent.kgPendiente>0&&<span style={{fontWeight:400,color:"var(--txt3)"}}> · Faltan {ent.kgPendiente.toLocaleString()} kg</span>}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
              <div style={{fontSize:8,color:"var(--txt3)",letterSpacing:2,marginBottom:7}}>EMBARQUES ({embs.length})</div>
              {embs.length===0&&<div style={{fontSize:11,color:"var(--txt3)",textAlign:"center",padding:"12px 0"}}>Sin embarques</div>}
              {embs.map(function(s){
                const cfg=STATUS_CONFIG[s.status]||STATUS_CONFIG["En Preparación"];
                const linesForThis=(s.productosEmbarque||[]).filter(l=>l.contratoId===sel.id);
                const kgForThis=linesForThis.reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
                return (
                  <div key={s.id} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:6,padding:"8px 10px",marginBottom:5}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div>
                        <div style={{fontSize:11,color:"#0EA5E9",fontWeight:700}}>{s.proforma||s.id}</div>
                        <div style={{fontSize:8,color:"var(--txt3)"}}>{s.destino}{linesForThis.length>0?" · "+linesForThis.map(l=>l.contratoProducto).filter(Boolean).join(", "):""}</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:10,color:"#3B82F6",fontWeight:700}}>{kgForThis.toLocaleString()} kg</div>
                        <span style={{fontSize:8,color:cfg.color,background:cfg.bg,padding:"1px 6px",borderRadius:100}}>{cfg.icon} {s.status}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              {sel.notas&&<div style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:6,padding:"8px 10px",marginTop:8}}><div style={{fontSize:7,color:"var(--txt3)",letterSpacing:2,marginBottom:2}}>NOTAS</div><div style={{fontSize:10,color:"var(--txt2)",lineHeight:1.5}}>{sel.notas}</div></div>}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
// ── Proformas Tab ─────────────────────────────────────────
function ProformasTab({proformas,contracts,onNew,onEdit,onPrint,onDelete,bankAccounts,company}) {
  const [search,setSearch]=useState("");
  const filtered=proformas.filter(p=>{const q=search.toLowerCase();return!q||p.numero.toLowerCase().includes(q)||p.cliente.toLowerCase().includes(q)||(p.contratoId||"").toLowerCase().includes(q);});
  return (
    <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 92px)"}}>
      <div style={{padding:"10px 20px",borderBottom:"1px solid var(--bdr)",display:"flex",gap:10,alignItems:"center"}}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar proforma, cliente, contrato..." style={{flex:1,background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:8,padding:"7px 14px",color:"var(--txt)",fontSize:11,fontFamily:"inherit"}}/>
        <button onClick={onNew} style={{background:"linear-gradient(135deg,#0EA5E9,#0369A1)",color:"#fff",padding:"7px 16px",borderRadius:8,fontSize:11,fontFamily:"inherit",fontWeight:700,whiteSpace:"nowrap"}}>+ NUEVA PROFORMA</button>
      </div>
      <div style={{flex:1,overflowY:"auto"}}>
        {filtered.length===0?(<div style={{textAlign:"center",padding:"60px 20px",color:"var(--txt3)",fontSize:13}}>No hay proformas. Creá la primera con <b style={{color:"#0EA5E9"}}>+ NUEVA PROFORMA</b></div>):(
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr style={{borderBottom:"1px solid var(--bdr)"}}>
            {["N° PROFORMA","CONTRATO","CLIENTE","FECHA","INCOTERM","TOTAL USD","KG NETOS",""].map(h=>(
              <th key={h} style={{padding:"9px 12px",textAlign:"left",fontSize:9,color:"var(--txt3)",letterSpacing:2,fontWeight:700,whiteSpace:"nowrap"}}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {filtered.map((p,i)=>{
              const netKg=p.lineas.reduce((a,l)=>a+(parseFloat(l.cantidadBolsones)||0)*(parseFloat(l.pesoBolson)||25),0);
              const lineTotal=p.lineas.reduce((a,l)=>{const kg=(parseFloat(l.cantidadBolsones)||0)*(parseFloat(l.pesoBolson)||25);return a+kg*(parseFloat(l.precio)||0);},0);
              const freightTotal=(parseFloat(p.freightContainers)||0)*(parseFloat(p.freightRate)||0);
              const grandTotal=lineTotal+freightTotal+(parseFloat(p.seguro)||0);
              return (
                <tr key={p.id} className="srow" onClick={()=>onEdit(p)} style={{borderBottom:"1px solid var(--bdr2)",cursor:"pointer",animation:`fadeUp 0.25s ease ${i*0.04}s both`}}>
                  <td style={{padding:"10px 12px"}}><div style={{fontSize:13,color:"#0EA5E9",fontWeight:700}}>{p.numero}</div><div style={{fontSize:9,color:"var(--txt3)",marginTop:1}}>{fmtDate(p.fecha)}</div></td>
                  <td style={{padding:"10px 12px",fontSize:12,color:"#10B981",fontWeight:700}}>{p.contratoId||"—"}</td>
                  <td style={{padding:"10px 12px",fontSize:12,color:"var(--txt)"}}>{p.cliente}</td>
                  <td style={{padding:"10px 12px",fontSize:11,color:"var(--txt2)"}}>{fmtDate(p.fecha)}</td>
                  <td style={{padding:"10px 12px",fontSize:11,color:"var(--txt2)"}}><span style={{background:"rgba(14,165,233,0.1)",color:"#0EA5E9",padding:"2px 7px",borderRadius:100,fontSize:10,fontWeight:700}}>{p.incoterm}</span></td>
                  <td style={{padding:"10px 12px"}}><div style={{fontSize:13,color:"#0EA5E9",fontWeight:800}}>USD {grandTotal.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</div></td>
                  <td style={{padding:"10px 12px",fontSize:12,color:"var(--hdg)",fontWeight:700}}>{netKg.toLocaleString()} kg</td>
                  <td style={{padding:"10px 7px",whiteSpace:"nowrap"}}>
                    <button onClick={e=>{e.stopPropagation();const bank=bankAccounts.find(b=>String(b.id)===String(p.bankAccountId))||null;onPrint(p,bank);}} title="Generar PDF" style={{color:"#10B981",fontSize:13,padding:"3px 7px",borderRadius:5,border:"1px solid rgba(16,185,129,0.3)",background:"rgba(16,185,129,0.08)",marginRight:4}}>⎙</button>
                    <button onClick={e=>{e.stopPropagation();onDelete(p.id);}} style={{color:"#EF4444",fontSize:13,padding:"3px 7px",borderRadius:5,border:"1px solid rgba(239,68,68,0.3)",background:"rgba(239,68,68,0.08)"}}>🗑</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>)}
      </div>
    </div>
  );
}

// ── Bank Accounts Modal ───────────────────────────────────
function BankAccountsModal({bankAccounts,onSave,onDelete,onClose}) {
  const [form,setForm]=useState({...EMPTY_BANK,id:`bank-${Date.now()}`});
  const [editId,setEditId]=useState(null);
  const [showForm,setShowF]=useState(false);
  const ISB={width:"100%",background:"var(--bg)",border:"1px solid var(--bdr)",borderRadius:7,padding:"8px 11px",color:"var(--txt)",fontSize:11,fontFamily:"inherit"};
  function startNew(){setForm({...EMPTY_BANK,id:`bank-${Date.now()}`});setEditId(null);setShowF(true);}
  function startEdit(b){setForm({...b});setEditId(b.id);setShowF(true);}
  function save(){if(!form.banco)return;onSave({...form},editId);setShowF(false);}
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(3,6,12,0.92)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}}>
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:16,width:560,maxHeight:"90vh",overflowY:"auto",padding:26,animation:"fadeUp 0.22s ease"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <div><div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:17,color:"var(--hdg)"}}>🏦 CUENTAS BANCARIAS</div><div style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,marginTop:2}}>DATOS PARA PROFORMA INVOICE</div></div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={startNew} style={{fontSize:10,color:"#10B981",background:"rgba(16,185,129,0.08)",border:"1px solid rgba(16,185,129,0.25)",borderRadius:7,padding:"5px 12px",fontFamily:"inherit",fontWeight:700}}>+ Nueva cuenta</button>
            <button onClick={onClose} style={{color:"var(--txt3)",fontSize:18}}>✕</button>
          </div>
        </div>
        {bankAccounts.length===0&&!showForm&&<div style={{textAlign:"center",padding:"28px 0",color:"var(--txt3)",fontSize:12}}>No hay cuentas bancarias cargadas. Agregá la primera.</div>}
        {bankAccounts.map(b=>(
          <div key={b.id} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:10,padding:12,marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,color:"#0EA5E9",fontWeight:700,marginBottom:4}}>{b.banco}</div>
                <div style={{fontSize:9,color:"var(--txt3)",whiteSpace:"pre-line",lineHeight:1.6}}>{b.datosBancarios||b.correspondent||b.cuenta||"—"}</div>
              </div>
              <div style={{display:"flex",gap:5,marginLeft:10,flexShrink:0}}>
                <button onClick={()=>startEdit(b)} style={{color:"#0EA5E9",fontSize:12,padding:"3px 7px",borderRadius:5,border:"1px solid rgba(14,165,233,0.3)",background:"rgba(14,165,233,0.08)"}}>✎</button>
                <button onClick={()=>onDelete(b.id)} style={{color:"#EF4444",fontSize:12,padding:"3px 7px",borderRadius:5,border:"1px solid rgba(239,68,68,0.3)",background:"rgba(239,68,68,0.08)"}}>🗑</button>
              </div>
            </div>
          </div>
        ))}
        {showForm&&(
          <div style={{background:"var(--bg3)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:10,padding:14,marginTop:10}}>
            <div style={{fontSize:10,color:"#F59E0B",fontWeight:700,letterSpacing:1,marginBottom:12}}>{editId?"EDITAR CUENTA":"NUEVA CUENTA"}</div>
            <div style={{marginBottom:10}}>
              <label style={{fontSize:7,color:"var(--txt3)",letterSpacing:1.5,display:"block",marginBottom:3}}>BANCO *</label>
              <input value={form.banco||""} onChange={e=>setForm(p=>({...p,banco:e.target.value}))} placeholder="Ej: Banco Nación, ICBC, Galicia..." style={ISB}/>
            </div>
            <div style={{marginBottom:12}}>
              <label style={{fontSize:7,color:"var(--txt3)",letterSpacing:1.5,display:"block",marginBottom:3}}>DATOS BANCARIOS</label>
              <textarea value={form.datosBancarios||""} onChange={e=>setForm(p=>({...p,datosBancarios:e.target.value}))} rows={8} placeholder={"Pegá acá todos los datos bancarios completos:\n\nFIELD 54 / RECEIVER'S CORRESPONDENT\nBANCO DE LA NACION ARGENTINA\nNEW YORK BRANCH - USA\nSWIFT CODE: NACNUS33\n\nFIELD 57 / ACCOUNT WITH INSTITUTION\n..."} style={{...ISB,resize:"vertical",lineHeight:1.6}}/>
            </div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button onClick={()=>setShowF(false)} style={{padding:"7px 16px",borderRadius:7,fontSize:11,fontFamily:"inherit",color:"var(--txt3)",background:"transparent",border:"1px solid var(--bdr)"}}>Cancelar</button>
              <button onClick={save} style={{padding:"7px 16px",borderRadius:7,fontSize:11,fontFamily:"inherit",background:"linear-gradient(135deg,#F59E0B,#D97706)",color:"#fff",fontWeight:700}}>Guardar Cuenta</button>
            </div>
          </div>
        )}
        <div style={{display:"flex",justifyContent:"flex-end",marginTop:14}}><button onClick={onClose} style={{padding:"9px 22px",borderRadius:8,fontSize:12,fontFamily:"inherit",background:"rgba(14,165,233,0.12)",color:"#0EA5E9",border:"1px solid rgba(14,165,233,0.3)",fontWeight:700}}>LISTO</button></div>
      </div>
    </div>
  );
}

// ── Proforma Form Modal ───────────────────────────────────
function ProformaForm({pf,setPf,contracts,clients,bankAccounts,onSave,onClose,onShowBanks,editingId,company}) {
  const [error,setError]=useState("");
  const ISF={width:"100%",background:"var(--bg)",border:"1px solid var(--bdr)",borderRadius:7,padding:"8px 11px",color:"var(--txt)",fontSize:11,fontFamily:"inherit"};
  const LabelS={fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:4};
  const LS={fontSize:7,color:"var(--txt3)",letterSpacing:1.5,display:"block",marginBottom:3};

  function applyClientData(nombre){
    const cli=clients.find(c=>c.nombre===nombre);
    if(!cli)return;
    setPf(p=>({...p,
      cliente:cli.nombre,
      emailCliente:cli.email||p.emailCliente,
      contacto:[cli.email,cli.email2,cli.telefono].filter(Boolean).join(" / ")||p.contacto,
      direccionCliente:cli.direccion||p.direccionCliente,
    }));
  }

  function addContrato(cId){
    if(!cId||(pf.contratosIds||[]).includes(cId))return;
    const cont=contracts.find(c=>c.id===cId);
    if(!cont)return;
    const newLineas=(cont.productos||[]).filter(p=>p.nombre).map(prod=>({
      ...EMPTY_PF_LINE(),contratoRef:cId,
      descripcionEn:`Argentinean ${prod.nombre}`,
      cantidadBolsones:prod.cantidadKg?Math.round(parseFloat(prod.cantidadKg)/25):"",
    }));
    const isFirst=(pf.contratosIds||[]).length===0;
    const cli=clients.find(c=>c.nombre===cont.cliente);
    setPf(p=>({...p,
      contratosIds:[...(p.contratosIds||[]),cId],
      contratoId:cId,
      ...(isFirst?{
        cliente:cont.cliente,
        incoterm:cont.incoterm||p.incoterm,
        puertoDestino:cont.puertoDestino||p.puertoDestino,
        emailCliente:cli?.email||p.emailCliente,
        contacto:[cli?.email,cli?.email2,cli?.telefono].filter(Boolean).join(" / ")||p.contacto,
        direccionCliente:cli?.direccion||p.direccionCliente,
      }:{}),
      lineas:[...p.lineas,...newLineas],
    }));
  }

  function removeContrato(cId){
    const remaining=(pf.contratosIds||[]).filter(id=>id!==cId);
    setPf(p=>({...p,contratosIds:remaining,contratoId:remaining[0]||"",lineas:p.lineas.filter(l=>l.contratoRef!==cId)}));
  }

  const contratosIds=pf.contratosIds||[];
  const contratosDisponibles=contracts.filter(c=>!contratosIds.includes(c.id));
  const netKg=pf.lineas.reduce((a,l)=>a+(parseFloat(l.cantidadBolsones)||0)*(parseFloat(l.pesoBolson)||25),0);
  const lineTotal=pf.lineas.reduce((a,l)=>{const kg=(parseFloat(l.cantidadBolsones)||0)*(parseFloat(l.pesoBolson)||25);return a+kg*(parseFloat(l.precio)||0);},0);
  const freightTotal=(parseFloat(pf.freightContainers)||0)*(parseFloat(pf.freightRate)||0);
  const seguroTotal=parseFloat(pf.seguro)||0;
  const grandTotal=lineTotal+freightTotal+seguroTotal;
  function save(){if(!pf.numero){setError("El número de proforma es obligatorio.");return;}if(!pf.cliente){setError("El cliente es obligatorio.");return;}setError("");onSave();}

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(3,6,12,0.88)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}}>
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:16,width:880,maxHeight:"94vh",overflowY:"auto",padding:28,animation:"fadeUp 0.22s ease"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
          <div><div style={{fontFamily:"'Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:"var(--hdg)"}}>{editingId?"EDITAR PROFORMA":"NUEVA PROFORMA"}</div><div style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,marginTop:2}}>PROFORMA INVOICE + PACKING LIST</div></div>
          <div style={{display:"flex",gap:8}}><button onClick={onShowBanks} style={{fontSize:10,color:"#F59E0B",background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:7,padding:"6px 12px",fontFamily:"inherit",fontWeight:700}}>🏦 Cuentas</button><button onClick={onClose} style={{color:"var(--txt3)",fontSize:20}}>✕</button></div>
        </div>

        {/* N°, Fecha, PO */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:14}}>
          <div><label style={LabelS}>N° PROFORMA *</label><input value={pf.numero} onChange={e=>setPf(p=>({...p,numero:e.target.value}))} placeholder="Ej: 116-2026" style={ISF}/></div>
          <div><label style={LabelS}>FECHA</label><input type="date" value={pf.fecha} onChange={e=>setPf(p=>({...p,fecha:e.target.value}))} style={ISF}/></div>
          <div><label style={LabelS}>ORDEN DE COMPRA / PO</label><input value={pf.po||""} onChange={e=>setPf(p=>({...p,po:e.target.value}))} placeholder="-" style={ISF}/></div>
        </div>

        {/* Contratos vinculados */}
        <div style={{marginBottom:14,background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:10,padding:12}}>
          <div style={{fontSize:10,color:"var(--txt3)",letterSpacing:2,fontWeight:700,marginBottom:4}}>CONTRATOS VINCULADOS</div>
          <div style={{fontSize:9,color:"var(--txt3)",marginBottom:8}}>Podés linkear uno o varios — cada uno agrega sus líneas de producto automáticamente</div>
          {contratosIds.length>0&&(
            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
              {contratosIds.map(cId=>{
                const cont=contracts.find(c=>c.id===cId);
                return cont?(
                  <div key={cId} style={{display:"flex",alignItems:"center",gap:6,background:"rgba(16,185,129,0.1)",border:"1px solid rgba(16,185,129,0.3)",borderRadius:7,padding:"4px 10px"}}>
                    <span style={{fontSize:11,color:"#10B981",fontWeight:700}}>{cont.numero}</span>
                    <span style={{fontSize:10,color:"var(--txt3)"}}>{cont.cliente}</span>
                    <button onClick={()=>removeContrato(cId)} style={{color:"#EF4444",fontSize:12,padding:"0 2px",background:"none",marginLeft:2}}>✕</button>
                  </div>
                ):null;
              })}
            </div>
          )}
          {contratosDisponibles.length>0&&(
            <select defaultValue="" onChange={e=>{if(e.target.value){addContrato(e.target.value);e.target.value="";}}} style={{...ISF}}>
              <option value="">{contratosIds.length===0?"+ Seleccionar contrato...":"+ Agregar otro contrato..."}</option>
              {contratosDisponibles.map(c=><option key={c.id} value={c.id}>{c.numero} – {c.cliente} ({(c.productos||[]).map(p=>p.nombre).join(", ")})</option>)}
            </select>
          )}
        </div>

        {/* Cliente */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:14}}>
          <div>
            <label style={LabelS}>CLIENTE (BUYER) *</label>
            <input list="pf-cli-list" value={pf.cliente||""} onChange={e=>{setPf(p=>({...p,cliente:e.target.value}));applyClientData(e.target.value);}} placeholder="Escribir o elegir cliente..." style={ISF}/>
            <datalist id="pf-cli-list">{clients.map(c=><option key={c.id} value={c.nombre}/>)}</datalist>
            {pf.cliente&&clients.find(c=>c.nombre===pf.cliente)&&<div style={{fontSize:8,color:"#10B981",marginTop:2}}>✓ Datos cargados desde la base de clientes</div>}
          </div>
          <div><label style={LabelS}>DIRECCIÓN CLIENTE</label><input value={pf.direccionCliente||""} onChange={e=>setPf(p=>({...p,direccionCliente:e.target.value}))} placeholder="Dirección postal" style={ISF}/></div>
          <div><label style={LabelS}>VAT / EORI</label><input value={pf.vat||""} onChange={e=>setPf(p=>({...p,vat:e.target.value}))} placeholder="VAT: 112 111 668 / EORI..." style={ISF}/></div>
          <div><label style={LabelS}>CONTACTO (email/teléfono)</label><input value={pf.contacto||""} onChange={e=>setPf(p=>({...p,contacto:e.target.value}))} placeholder="email@cliente.com" style={ISF}/></div>
          <div><label style={LabelS}>INCOTERM</label><select value={pf.incoterm||"FOB"} onChange={e=>setPf(p=>({...p,incoterm:e.target.value}))} style={ISF}>{INCOTERMS.map(o=><option key={o}>{o}</option>)}</select></div>
          <div><label style={LabelS}>PUERTO DESTINO</label><input value={pf.puertoDestino||""} onChange={e=>setPf(p=>({...p,puertoDestino:e.target.value}))} placeholder="Ej: RIJEKA" style={ISF}/></div>
        </div>

        {/* Líneas */}
        <div style={{marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div><div style={{fontSize:10,color:"var(--txt3)",letterSpacing:2,fontWeight:700}}>LÍNEAS DE PRODUCTO</div><div style={{fontSize:9,color:"var(--txt3)",marginTop:1}}>Contenedor y Precinto completar después de la carga.</div></div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              {netKg>0&&<div style={{fontSize:11,color:"#0EA5E9",fontWeight:800}}>Net: {netKg.toLocaleString()} kg · USD {lineTotal.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</div>}
              <button onClick={()=>setPf(p=>({...p,lineas:[...p.lineas,EMPTY_PF_LINE()]}))} style={{fontSize:10,color:"#3B82F6",background:"rgba(59,130,246,0.08)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:7,padding:"5px 12px",fontFamily:"inherit",fontWeight:700}}>+ Agregar línea</button>
            </div>
          </div>
          {pf.lineas.length===0&&<div style={{textAlign:"center",padding:"18px",color:"var(--txt3)",fontSize:11,borderRadius:8,border:"1px dashed var(--bdr)"}}>Vinculá un contrato o agregá líneas manualmente.</div>}
          {pf.lineas.map((l,li)=>{
            const kgLine=(parseFloat(l.cantidadBolsones)||0)*(parseFloat(l.pesoBolson)||25);
            const totLine=kgLine*(parseFloat(l.precio)||0);
            const upd=fn=>setPf(p=>({...p,lineas:p.lineas.map((x,i)=>i===li?fn(x):x)}));
            const refCont=l.contratoRef?contracts.find(c=>c.id===l.contratoRef):null;
            return (
              <div key={l.id} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:10,padding:12,marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:10,color:"#3B82F6",fontWeight:700}}>Línea {li+1}</span>
                    {refCont&&<span style={{fontSize:9,color:"#10B981",background:"rgba(16,185,129,0.1)",border:"1px solid rgba(16,185,129,0.2)",borderRadius:5,padding:"1px 7px"}}>{refCont.numero}</span>}
                    {kgLine>0&&<span style={{color:"var(--txt3)",fontSize:9}}>{kgLine.toLocaleString()} kg · USD {totLine.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</span>}
                  </div>
                  <button onClick={()=>setPf(p=>({...p,lineas:[...p.lineas.slice(0,li+1),{...l,id:`l-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,containerNum:"",precinto:""},...p.lineas.slice(li+1)]}))} title="Duplicar línea" style={{color:"#A78BFA",fontSize:11,padding:"2px 6px",borderRadius:4,border:"1px solid rgba(167,139,250,0.2)",background:"rgba(167,139,250,0.06)",marginRight:4}}>⧉</button>{pf.lineas.length>1&&<button onClick={()=>setPf(p=>({...p,lineas:p.lineas.filter((_,i)=>i!==li)}))} style={{color:"#EF4444",fontSize:11,padding:"2px 6px",borderRadius:4,border:"1px solid rgba(239,68,68,0.2)",background:"rgba(239,68,68,0.06)"}}>✕</button>}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"2fr 2fr",gap:8,marginBottom:7}}>
                  <div><label style={LS}>DESCRIPCIÓN INGLÉS</label>
                  {company?.id==="co1"&&(clients.find(c=>c.nombre===pf.cliente)||{}).productos?.length>0?(
                    <select value={l.descripcionEn} onChange={e=>upd(x=>({...x,descripcionEn:e.target.value}))} style={ISF}>
                      <option value="">— Seleccionar producto —</option>
                      {(clients.find(c=>c.nombre===pf.cliente)?.productos||[]).map(p=>(<option key={p} value={p}>{p}</option>))}
                    </select>
                  ):(
                    <input value={l.descripcionEn} onChange={e=>upd(x=>({...x,descripcionEn:e.target.value}))} placeholder="Ej: Raw 40/50 Argentinean Peanuts" style={ISF}/>
                  )}
                </div>
                  <div><label style={LS}>EMPAQUE / PACKAGING</label><input value={l.empaque} onChange={e=>upd(x=>({...x,empaque:e.target.value}))} placeholder="In Polypropylene bags x 25Kg. with Tags" style={ISF}/></div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 2fr",gap:8,marginBottom:7}}>
                  <div><label style={LS}>CANT. BOLSAS / BAGS</label><input type="number" value={l.cantidadBolsones} onChange={e=>upd(x=>({...x,cantidadBolsones:e.target.value}))} placeholder="1000" style={ISF}/></div>
                  <div><label style={LS}>KG / BOLSA</label><input type="number" value={l.pesoBolson} onChange={e=>upd(x=>({...x,pesoBolson:parseFloat(e.target.value)||25}))} placeholder="25" style={ISF}/></div>
                  <div><label style={LS}>PRECIO USD/KG</label><input type="number" step="0.0001" value={l.precio} onChange={e=>upd(x=>({...x,precio:e.target.value}))} placeholder="1.1564" style={ISF}/></div>
                  <div><label style={LS}>LOTE / BATCH</label><input value={l.lote} onChange={e=>upd(x=>({...x,lote:e.target.value}))} placeholder="25140044" style={ISF}/></div>
                  <div><label style={LS}>POSICIÓN ARANCELARIA</label><select value={l.pa} onChange={e=>upd(x=>({...x,pa:e.target.value}))} style={ISF}><option value="">— Elegir P.A. —</option>{getTariffPositions(company?.id).map(t=><option key={t.code} value={t.code}>{t.code} – {t.desc}</option>)}</select></div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,borderTop:"1px dashed var(--bdr)",paddingTop:7}}>
                  <div><label style={{...LS,color:"#F59E0B"}}>CONTENEDOR N° — completar después de carga</label><input value={l.containerNum} onChange={e=>upd(x=>({...x,containerNum:e.target.value}))} placeholder="Ej: TCKU3456789" style={ISF}/></div>
                  <div><label style={{...LS,color:"#F59E0B"}}>PRECINTO / SEAL — completar después de carga</label><input value={l.precinto} onChange={e=>upd(x=>({...x,precinto:e.target.value}))} placeholder="Ej: P123456" style={ISF}/></div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Flete + Pesos */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <div style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:10,padding:12}}>
            <div style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,fontWeight:700,marginBottom:8}}>FLETE / FREIGHT</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              <div><label style={LS}>N° CONTENEDORES</label><input type="number" value={pf.freightContainers||""} onChange={e=>setPf(p=>({...p,freightContainers:e.target.value}))} placeholder="3" style={ISF}/></div>
              <div><label style={LS}>TARIFA USD/CONTENEDOR</label><input type="number" value={pf.freightRate||""} onChange={e=>setPf(p=>({...p,freightRate:e.target.value}))} placeholder="1090" style={ISF}/></div>
            </div>
            {pf.freightRate&&pf.freightContainers&&<div style={{fontSize:10,color:"#0EA5E9",fontWeight:700,marginBottom:8}}>Total flete: USD {freightTotal.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</div>}
            <div style={{marginBottom:8}}><label style={LS}>EMBARQUE (Ej: 3x40HC)</label><input value={pf.shipmentDesc||""} onChange={e=>setPf(p=>({...p,shipmentDesc:e.target.value}))} placeholder="Ej: 3x40HC" style={ISF}/></div>
            <div><label style={{...LS,color:"#10B981"}}>SEGURO / INSURANCE (USD) — solo para CIF</label><input type="number" step="0.01" value={pf.seguro||""} onChange={e=>setPf(p=>({...p,seguro:e.target.value}))} placeholder="Ej: 1250.00" style={ISF}/>{seguroTotal>0&&<div style={{fontSize:8,color:"#10B981",marginTop:2}}>✓ Se suma al total y aparece en la Proforma</div>}</div>
          </div>
          <div style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:10,padding:12}}>
            <div style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,fontWeight:700,marginBottom:8}}>PESOS / WEIGHTS</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              <div><label style={LS}>PESO NETO KG (vacío = auto)</label><input type="number" value={pf.netWeight||""} onChange={e=>setPf(p=>({...p,netWeight:e.target.value}))} placeholder={netKg?netKg.toString():"Auto"} style={ISF}/>{netKg>0&&<div style={{fontSize:8,color:"var(--txt3)",marginTop:2}}>Calculado: {netKg.toLocaleString()} kg</div>}</div>
              <div><label style={LS}>PESO BRUTO KG</label><input type="number" value={pf.grossWeight||""} onChange={e=>setPf(p=>({...p,grossWeight:e.target.value}))} placeholder="Completar después de carga" style={ISF}/></div>
            </div>
            <div><label style={LS}>ORIGEN DE LA MERCADERÍA</label><input value={pf.origen||"ARGENTINA"} onChange={e=>setPf(p=>({...p,origen:e.target.value}))} style={ISF}/></div>
          </div>
        </div>

        {/* Pago + Banco */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <div><label style={LabelS}>CONDICIÓN DE PAGO / PAYMENT TERMS</label><input value={pf.paymentTerms||""} onChange={e=>setPf(p=>({...p,paymentTerms:e.target.value}))} placeholder="Ej: 100% CAD" style={ISF}/></div>
          <div><label style={LabelS}>CUENTA BANCARIA</label><div style={{display:"flex",gap:7}}><select value={pf.bankAccountId||""} onChange={e=>setPf(p=>({...p,bankAccountId:e.target.value}))} style={{...ISF,flex:1}}><option value="">— Sin cuenta seleccionada —</option>{bankAccounts.map(b=><option key={b.id} value={b.id}>{(b.nombre||b.banco)} — {b.datosBancarios?b.datosBancarios.substring(0,30)+"...":""}</option>)}</select><button onClick={onShowBanks} title="Gestionar cuentas" style={{padding:"8px 11px",borderRadius:7,background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.3)",color:"#F59E0B",fontSize:14}}>🏦</button></div></div>
        </div>

        {/* Condiciones + Notas */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <div><label style={LS}>CONDITIONS / CONDICIONES</label><textarea value={pf.conditions||""} onChange={e=>setPf(p=>({...p,conditions:e.target.value}))} rows={3} style={{...ISF,resize:"vertical"}}/></div>
          <div><label style={LS}>NOTAS INTERNAS</label><textarea value={pf.notas||""} onChange={e=>setPf(p=>({...p,notas:e.target.value}))} rows={3} style={{...ISF,resize:"vertical"}}/></div>
        </div>

        {error&&<div style={{marginBottom:12,padding:"9px 12px",borderRadius:7,fontSize:11,background:"rgba(239,68,68,0.1)",color:"#EF4444",border:"1px solid rgba(239,68,68,0.3)"}}>⚠ {error}</div>}
        {grandTotal>0&&<div style={{background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.2)",borderRadius:8,padding:"10px 14px",marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{fontSize:11,color:"var(--txt2)"}}>Net: <b style={{color:"var(--txt)"}}>{netKg.toLocaleString()} kg</b> &nbsp;·&nbsp; Mercadería: <b style={{color:"var(--txt)"}}>USD {lineTotal.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</b> &nbsp;·&nbsp; Flete: <b style={{color:"var(--txt)"}}>USD {freightTotal.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</b>{seguroTotal>0&&<span> &nbsp;·&nbsp; Seguro: <b style={{color:"var(--txt)"}}>USD {seguroTotal.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</b></span>}</div>
          <div style={{fontSize:14,color:"#0EA5E9",fontWeight:800}}>TOTAL: USD {grandTotal.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
        </div>}
        <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
          <button onClick={onClose} style={{padding:"9px 20px",borderRadius:8,fontSize:12,fontFamily:"inherit",color:"var(--txt3)",background:"transparent",border:"1px solid var(--bdr)"}}>CANCELAR</button>
          <button onClick={save} style={{padding:"9px 22px",borderRadius:8,fontSize:12,fontFamily:"inherit",background:"rgba(14,165,233,0.15)",color:"#0EA5E9",border:"1px solid rgba(14,165,233,0.3)",fontWeight:700}}>💾 GUARDAR</button>
          {(pf.numero&&pf.cliente)&&<button onClick={()=>{save();const bank=bankAccounts.find(b=>String(b.id)===String(pf.bankAccountId))||null;printProformaDoc(pf,company,bank);}} style={{padding:"9px 22px",borderRadius:8,fontSize:12,fontFamily:"inherit",background:"linear-gradient(135deg,#10B981,#059669)",color:"#fff",fontWeight:700}}>⎙ GUARDAR + GENERAR PDF</button>}
        </div>
      </div>
    </div>
  );
}

function ExportModal({shipments,contracts,clients,onClose,currentTab}) {
  const tabToTipo = {lista:"embarques",contratos:"contratos",clientes:"clientes",vencimientos:"vencimientos"};
  const [tipoReporte,setTipoReporte]=useState(tabToTipo[currentTab]||"embarques");
  const [fc,setFc]=useState("Todos");
  const [fk,setFk]=useState("Todos");
  const [xlsxLoading,setXlsxLoading]=useState(false);
  const cls=["Todos",...Array.from(new Set(shipments.map(s=>s.cliente).filter(Boolean))).sort()];
  const cts=["Todos",...contracts.map(c=>c.numero)];
  const filtered=shipments.filter(s=>{
    const okC=fc==="Todos"||s.cliente===fc;
    const okK=fk==="Todos"||s.contratoId===contracts.find(c=>c.numero===fk)?.id||(s.productosEmbarque||[]).some(l=>l.contratoId===contracts.find(c=>c.numero===fk)?.id);
    return okC&&okK;
  });
  const grupos=filtered.reduce((m,s)=>{const k=s.contratoId||"__";if(!m[k])m[k]=[];m[k].push(s);return m;},{});
  const IST={width:"100%",background:"var(--bg)",border:"1px solid var(--bdr)",borderRadius:8,padding:"9px 12px",color:"var(--txt)",fontSize:12,fontFamily:"inherit"};

  const TIPOS=[
    {id:"embarques",label:"📦 Embarques"},
    {id:"contratos",label:"📋 Contratos"},
    {id:"clientes",label:"👥 Clientes"},
    {id:"vencimientos",label:"📅 Vencimientos"},
  ];

  function doPrint(){
    const today=new Date().toLocaleDateString("es-AR",{day:"2-digit",month:"long",year:"numeric"});
    const style=`<style>@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@400;600&display=swap');*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Barlow',sans-serif;background:#fff;color:#111;padding:28px;font-size:11px}h1{font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:800;color:#0369A1;margin-bottom:2px}.sub{font-size:8px;color:#64748B;letter-spacing:2px;margin-bottom:20px}.section{margin-bottom:28px;page-break-inside:avoid}.stitle{font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:700;color:#0369A1;border-bottom:2px solid #0369A1;padding-bottom:3px;margin-bottom:8px;text-transform:uppercase}.ptitle{font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:700;color:#334155;border-bottom:1px solid #CBD5E1;padding-bottom:2px;margin-bottom:6px;margin-top:10px;text-transform:uppercase;letter-spacing:1px}.cbox{background:#F0F7FF;border:1px solid #BAD6F5;border-radius:5px;padding:8px 12px;margin-bottom:8px}.cmeta{display:flex;gap:14px;flex-wrap:wrap;font-size:10px;color:#334155;margin-bottom:6px}.cmeta span b{color:#0369A1}.pbg{height:5px;background:#E2E8F0;border-radius:3px;margin-bottom:4px}.pbar{height:100%;border-radius:3px;background:linear-gradient(90deg,#3B82F6,#0EA5E9)}table{width:100%;border-collapse:collapse;font-size:10px}thead tr{background:#0369A1;color:#fff}th{padding:6px 8px;text-align:left;font-weight:700;font-size:8px}tbody tr:nth-child(even){background:#F8FAFC}td{padding:6px 8px;border-bottom:1px solid #E2E8F0;color:#334155}.num{font-weight:700;color:#0369A1}.bt{background:#DBEAFE;color:#1D4ED8;padding:1px 6px;border-radius:100px;font-size:8px;font-weight:700}.be{background:#DCFCE7;color:#166534;padding:1px 6px;border-radius:100px;font-size:8px;font-weight:700}.bp{background:#FEF3C7;color:#92400E;padding:1px 6px;border-radius:100px;font-size:8px;font-weight:700}.bd{background:#F1F5F9;color:#475569;padding:1px 6px;border-radius:100px;font-size:8px;font-weight:700}.totrow{font-weight:700;background:#EFF6FF!important;border-top:2px solid #BAD6F5}.footer{margin-top:24px;font-size:8px;color:#94A3B8;border-top:1px solid #E2E8F0;padding-top:8px;display:flex;justify-content:space-between}</style>`;
    const bc=st=>({"En Tránsito":"bt","Entregado":"be","En Preparación":"bp"}[st]||"bd");
    let body=``;

    // ── EMBARQUES ──
    if(tipoReporte==="embarques"){
      body=`<h1>⛵ EXPORTRAK — LISTA DE EMBARQUES</h1><div class="sub">GENERADO EL ${today.toUpperCase()} · ${filtered.length} EMBARQUES</div>`;
      body+=`<div class="section"><table><thead><tr><th>PROFORMA</th><th>CLIENTE</th><th>DESTINO</th><th>PRODUCTOS</th><th>KG TOTAL</th><th>RESERVA N°</th><th>SALIDA</th><th>ETA</th><th>ESTADO</th></tr></thead><tbody>`;
      body+=filtered.map(s=>{
        const prodStr=(s.productosEmbarque||[]).map(l=>`${l.contratoProducto||''}: ${parseFloat(l.cantidadKg||0).toLocaleString()} kg`).join('<br>')||s.producto||'—';
        return`<tr><td class="num">${s.proforma||s.id}</td><td>${s.cliente}</td><td>${s.destino||'—'}</td><td>${prodStr}</td><td>${(parseFloat(s.cantidadKg)||0).toLocaleString()} kg</td><td>${s.bl||"—"}</td><td>${s.fechaSalida||"—"}</td><td>${s.fechaEstimada||"—"}</td><td><span class="${bc(s.status)}">${s.status}</span></td></tr>`;
      }).join("");
      const totalKg=filtered.reduce((a,s)=>a+(parseFloat(s.cantidadKg)||0),0);
      if(totalKg>0)body+=`<tr class="totrow"><td colspan="4" style="text-align:right;font-weight:700">TOTAL:</td><td>${totalKg.toLocaleString()} kg</td><td colspan="4"></td></tr>`;
      body+=`</tbody></table></div>`;
    }

    // ── CONTRATOS ──
    else if(tipoReporte==="contratos"){
      body=`<h1>⛵ EXPORTRAK — CONTRATOS</h1><div class="sub">GENERADO EL ${today.toUpperCase()} · ${contracts.length} CONTRATOS</div>`;
      contracts.forEach(cont=>{
        const embsCont=shipments.filter(s=>(s.productosEmbarque||[]).some(l=>l.contratoId===cont.id)||s.contratoId===cont.id);
        const kgEmbTotal=embsCont.reduce((a,s)=>a+(parseFloat(s.cantidadKg)||0),0);
        const kgContTotal=(cont.productos||[]).reduce((a,p)=>a+(parseFloat(p.cantidadKg)||0),0);
        const pct=kgContTotal>0?Math.min(100,Math.round((kgEmbTotal/kgContTotal)*100)):0;
        body+=`<div class="section">`;
        body+=`<div class="stitle">${cont.numero} — ${cont.cliente}</div>`;
        body+=`<div class="cbox"><div class="cmeta">`;
        body+=`<span><b>Incoterm:</b> ${cont.incoterm||"—"}</span>`;
        body+=`<span><b>Puerto:</b> ${cont.puertoDestino||"—"}</span>`;
        body+=`<span><b>Destino:</b> ${cont.destinoFinal||"—"}</span>`;
        body+=`<span><b>KG Contratados:</b> ${kgContTotal.toLocaleString()}</span>`;
        body+=`<span><b>KG Embarcados:</b> ${kgEmbTotal.toLocaleString()}</span>`;
        body+=`<span><b>Saldo:</b> ${Math.max(0,kgContTotal-kgEmbTotal).toLocaleString()} kg</span>`;
        body+=`</div><div class="pbg"><div class="pbar" style="width:${pct}%"></div></div>`;
        body+=`<div style="font-size:9px;color:#0369A1;font-weight:700">${pct}% embarcado</div></div>`;
        (cont.productos||[]).forEach(prod=>{
          const embsProd=embsCont.filter(s=>(s.productosEmbarque||[]).some(l=>l.contratoId===cont.id&&(l.contratoProducto||"").trim().toLowerCase()===(prod.nombre||"").trim().toLowerCase()));
          const kgProdContratado=parseFloat(prod.cantidadKg)||0;
          const kgProdEmb=embsProd.reduce((a,s)=>{
            const lineas=(s.productosEmbarque||[]).filter(l=>l.contratoId===cont.id&&(l.contratoProducto||"").trim().toLowerCase()===(prod.nombre||"").trim().toLowerCase());
            return a+lineas.reduce((b,l)=>b+(parseFloat(l.cantidadKg)||0),0);
          },0);
          body+=`<div class="ptitle">▸ ${prod.nombre||"—"} &nbsp;·&nbsp; Contratado: ${kgProdContratado.toLocaleString()} kg &nbsp;·&nbsp; Embarcado: ${kgProdEmb.toLocaleString()} kg &nbsp;·&nbsp; Saldo: ${Math.max(0,kgProdContratado-kgProdEmb).toLocaleString()} kg</div>`;
          if(embsProd.length===0){
            body+=`<div style="font-size:9px;color:#94A3B8;padding:4px 0 8px 0">Sin embarques registrados para este producto.</div>`;
          } else {
            body+=`<table><thead><tr><th>PROFORMA</th><th>KG</th><th>RESERVA N°</th><th>SALIDA</th></tr></thead><tbody>`;
            body+=embsProd.map(s=>{
              const lineas=(s.productosEmbarque||[]).filter(l=>l.contratoId===cont.id&&(l.contratoProducto||"").trim().toLowerCase()===(prod.nombre||"").trim().toLowerCase());
              const kgLinea=lineas.reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
              return`<tr><td class="num">${s.proforma||s.id}</td><td>${kgLinea.toLocaleString()} kg</td><td>${s.bl||"—"}</td><td>${s.fechaSalida||"—"}</td></tr>`;
            }).join("");
            const totProd=embsProd.reduce((a,s)=>{
              const lineas=(s.productosEmbarque||[]).filter(l=>l.contratoId===cont.id&&(l.contratoProducto||"").trim().toLowerCase()===(prod.nombre||"").trim().toLowerCase());
              return a+lineas.reduce((b,l)=>b+(parseFloat(l.cantidadKg)||0),0);
            },0);
            body+=`<tr class="totrow"><td style="text-align:right">TOTAL:</td><td>${totProd.toLocaleString()} kg</td><td colspan="2"></td></tr>`;
            body+=`</tbody></table>`;
          }
          // ── Seguimiento de entregas por producto ──
          const entStatus = calcEntregasStatus(prod, shipments, cont.id);
          if (entStatus.length > 0) {
            body += `<div style="margin-top:8px;margin-bottom:12px"><div style="font-size:9px;font-weight:700;color:#334155;letter-spacing:1px;margin-bottom:5px;text-transform:uppercase">Seguimiento de Entregas</div>`;
            body += `<table><thead><tr><th>N°</th><th>FECHA</th><th>KG COMPROMETIDO</th><th>KG CUBIERTO</th><th>KG PENDIENTE</th><th>ESTADO</th><th>DÍAS</th></tr></thead><tbody>`;
            entStatus.forEach(ent => {
              const kgEnt = parseFloat(ent.cantidadKg)||0;
              const pct = kgEnt>0?Math.min(100,Math.round((ent.kgCubierto/kgEnt)*100)):0;
              const badgeCss = ent.status==='cubierta'
                ? 'background:#DCFCE7;color:#166534;padding:1px 7px;border-radius:100px;font-size:8px;font-weight:700'
                : ent.status==='parcial'
                ? 'background:#FEF3C7;color:#92400E;padding:1px 7px;border-radius:100px;font-size:8px;font-weight:700'
                : 'background:#FEE2E2;color:#991B1B;padding:1px 7px;border-radius:100px;font-size:8px;font-weight:700';
              const badgeLabel = ent.status==='cubierta'?'✓ Cubierta':ent.status==='parcial'?'⏳ Parcial':'⚠ Pendiente';
              const diasStr = ent.diasRestantes===null?'—':ent.diasRestantes<0?`Vencida ${Math.abs(ent.diasRestantes)}d`:ent.diasRestantes===0?'Hoy':`${ent.diasRestantes}d`;
              body += `<tr><td class="num">${ent.idx}</td><td>${ent.fecha?fmtDate(ent.fecha):'—'}</td><td>${kgEnt.toLocaleString()} kg</td><td>${ent.kgCubierto.toLocaleString()} kg (${pct}%)</td><td>${ent.kgPendiente>0?ent.kgPendiente.toLocaleString()+' kg':'—'}</td><td><span style="${badgeCss}">${badgeLabel}</span></td><td style="${ent.diasRestantes!==null&&ent.diasRestantes<0?'color:#DC2626;font-weight:700':''}">${diasStr}</td></tr>`;
            });
            body += `</tbody></table></div>`;
          }
        });
        body+=`</div>`;
      });
    }

    // ── CLIENTES ──
    else if(tipoReporte==="clientes"){
      body=`<h1>⛵ EXPORTRAK — CLIENTES</h1><div class="sub">GENERADO EL ${today.toUpperCase()} · ${clients.length} CLIENTES</div>`;
      body+=`<div class="section"><table><thead><tr><th>CLIENTE</th><th>EMAIL</th><th>2DO EMAIL</th><th>TELÉFONO</th><th>DIRECCIÓN</th></tr></thead><tbody>`;
      body+=clients.map(c=>`<tr><td class="num">${c.nombre}</td><td>${c.email||"—"}</td><td>${c.email2||"—"}</td><td>${c.telefono||"—"}</td><td>${c.direccion||"—"}</td></tr>`).join("");
      body+=`</tbody></table></div>`;
    }

    // ── VENCIMIENTOS ──
    else if(tipoReporte==="vencimientos"){
      const vencRows2=shipments.filter(s=>s.facturaNum&&s.vencimientoType&&s.fechaEstimada).map(s=>{
        const vf=calcVencFecha(s.fechaEstimada,s.vencimientoType);
        const dias=getDias(vf);
        return{...s,vf,dias};
      }).sort((a,b)=>{if(a.dias===null)return 1;if(b.dias===null)return-1;return a.dias-b.dias;});
      body=`<h1>⛵ EXPORTRAK — VENCIMIENTOS</h1><div class="sub">GENERADO EL ${today.toUpperCase()} · ${vencRows2.length} REGISTROS</div>`;
      body+=`<div class="section"><table><thead><tr><th>PROFORMA</th><th>CLIENTE</th><th>FACTURA N°</th><th>TIPO VENCIMIENTO</th><th>FECHA VENC.</th><th>DÍAS</th><th>ESTADO</th></tr></thead><tbody>`;
      body+=vencRows2.map(r=>{
        const est=r.dias===null?"—":r.dias<0?"VENCIDA":r.dias===0?"HOY":r.dias<=10?"PRÓXIMA":"OK";
        const estCls=r.dias!==null&&r.dias<0?"be":r.dias!==null&&r.dias<=10?"bp":"bd";
        return`<tr><td class="num">${r.proforma||r.id}</td><td>${r.cliente}</td><td>${r.facturaNum}</td><td>${r.vencimientoType}</td><td>${r.vf||"—"}</td><td>${r.dias!==null?`${r.dias}d`:"—"}</td><td><span class="${estCls}">${est}</span></td></tr>`;
      }).join("");
      body+=`</tbody></table></div>`;
    }

    body+=`<div class="footer"><span>EXPORTRAK · Sistema de Seguimiento de Exportaciones</span><span>${today}</span></div>`;
    const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>EXPORTRAK</title>${style}<script>window.onload=function(){window.print();}<\/script></head><body>${body}</body></html>`;
    const blob=new Blob([html],{type:"text/html"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");a.href=url;a.target="_blank";a.rel="noopener";
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  }

  async function doExcel(){
    setXlsxLoading(true);
    try {
      await new Promise((res,rej)=>{
        if(window.XLSX){res();return;}
        const s=document.createElement("script");
        s.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
        s.onload=res;s.onerror=rej;document.head.appendChild(s);
      });
      const XLSX=window.XLSX,wb=XLSX.utils.book_new();
      const today=new Date().toLocaleDateString("es-AR");
      const embH=["ID","Proforma","Cliente","Email Cliente","Destino","Productos","Contenedores","Kg Total","Naviera","Buque","Reserva N°","Fecha Salida","Fecha ETA","Estado","Estado Docs","Factura N°","Tipo Vencimiento","Fecha Vencimiento","Contrato Vinculado","Notas"];
      const embR=filtered.map(s=>{
        const prodStr=(s.productosEmbarque||[]).map(l=>`${l.contratoProducto||''}: ${parseFloat(l.cantidadKg||0).toLocaleString()} kg`).join(' | ');
        return [s.id,s.proforma||"",s.cliente,s.emailCliente||"",s.destino,prodStr||s.producto,s.volumen||"",parseFloat(s.cantidadKg)||0,s.naviera||"",s.buque||"",s.bl||"",s.fechaSalida||"",s.fechaEstimada||"",s.status,s.estadoDocs||"",s.facturaNum||"",s.vencimientoType||"",calcVencFecha(s.fechaEstimada,s.vencimientoType)||"",contracts.find(c=>c.id===s.contratoId)?.numero||"",s.notas||""];
      });
      const wsE=XLSX.utils.aoa_to_sheet([embH,...embR]);
      wsE["!cols"]=[{wch:14},{wch:16},{wch:20},{wch:24},{wch:16},{wch:32},{wch:10},{wch:10},{wch:14},{wch:16},{wch:14},{wch:12},{wch:12},{wch:14},{wch:14},{wch:14},{wch:16},{wch:14},{wch:16},{wch:28}];
      XLSX.utils.book_append_sheet(wb,wsE,"Embarques");
      const contH=["N° Contrato","Cliente","Productos","Lote","Incoterm","Puerto","Destino Final","Kg Contratados","Kg Embarcados","Saldo Kg","% Completado","Fecha Contrato","Notas"];
      const contR=contracts.map(c=>{
        const kgEmb=filtered.filter(s=>(s.productosEmbarque||[]).some(l=>l.contratoId===c.id)).reduce((tot,s)=>{
          return tot+(s.productosEmbarque||[]).filter(l=>l.contratoId===c.id).reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
        },0);
        const kgTotal=(c.productos||[]).reduce((a,p)=>a+(parseFloat(p.cantidadKg)||0),0);
        const pct=kgTotal>0?Math.round((kgEmb/kgTotal)*100):0;
        const prods=(c.productos||[]).map(p=>p.nombre).join(', ');
        return[c.numero,c.cliente,prods,c.lote||"",c.incoterm||"",c.puertoDestino||"",c.destinoFinal||"",kgTotal,kgEmb,Math.max(0,kgTotal-kgEmb),pct+"%",c.fechaContrato||"",c.notas||""];
      });
      const wsCo=XLSX.utils.aoa_to_sheet([contH,...contR]);
      wsCo["!cols"]=[{wch:14},{wch:22},{wch:28},{wch:14},{wch:8},{wch:16},{wch:18},{wch:12},{wch:12},{wch:10},{wch:10},{wch:12},{wch:28}];
      XLSX.utils.book_append_sheet(wb,wsCo,"Contratos");
      const cliH=["Nombre","Email","2do Email","Teléfono","Dirección"];
      const cliR=clients.map(c=>[c.nombre,c.email||"",c.email2||"",c.telefono||"",c.direccion||""]);
      const wsCli=XLSX.utils.aoa_to_sheet([cliH,...cliR]);
      wsCli["!cols"]=[{wch:30},{wch:32},{wch:32},{wch:22},{wch:55}];
      XLSX.utils.book_append_sheet(wb,wsCli,"Clientes");
      const vencRows=shipments.filter(s=>s.facturaNum&&s.vencimientoType&&s.fechaEstimada).map(s=>{
        const vf=calcVencFecha(s.fechaEstimada,s.vencimientoType);
        const dias=getDias(vf);
        const estado=dias===null?"Sin fecha":dias<0?"VENCIDA":dias===0?"HOY":dias<=10?"PRÓXIMA":"OK";
        return[s.proforma||s.id,s.cliente,s.facturaNum,s.vencimientoType,vf||"—",dias===null?"—":`${dias} días`,estado,s.emailCliente||"",contracts.find(c=>c.id===s.contratoId)?.numero||""];
      }).sort((a,b)=>{const da=getDias(a[4]),db=getDias(b[4]);if(da===null)return 1;if(db===null)return-1;return da-db;});
      const vencH=["Proforma","Cliente","Factura N°","Tipo Vencimiento","Fecha Vencimiento","Días Restantes","Estado","Email Cliente","Contrato"];
      const wsV=XLSX.utils.aoa_to_sheet([vencH,...vencRows]);
      wsV["!cols"]=[{wch:16},{wch:22},{wch:16},{wch:18},{wch:18},{wch:14},{wch:10},{wch:28},{wch:16}];
      XLSX.utils.book_append_sheet(wb,wsV,"Vencimientos");
      XLSX.writeFile(wb,`EXPORTRAK_${today.replace(/\//g,"-")}.xlsx`);
    } catch(e){alert("Error al generar Excel: "+e.message);}
    setXlsxLoading(false);
  }

  // Preview content based on tipo
  const previewContent = () => {
    if(tipoReporte==="embarques"){
      if(filtered.length===0)return<div style={{textAlign:"center",color:"var(--txt3)",padding:"20px 0"}}>Sin embarques para los filtros</div>;
      return(<>
        <div style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,marginBottom:10}}>VISTA PREVIA · {filtered.length} EMBARQUES</div>
        {Object.keys(grupos).map(key=>{
          const embs=grupos[key],cont=key!=="__"?contracts.find(c=>c.id===key):null;
          const kgEmb=embs.reduce((a,s)=>a+(parseFloat(s.cantidadKg)||0),0),kgTotal=cont?(cont.productos||[]).reduce((a,p)=>a+(parseFloat(p.cantidadKg)||0),0):0;
          const pct=kgTotal>0?Math.min(100,Math.round((kgEmb/kgTotal)*100)):0;
          return(<div key={key} style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{fontSize:11,color:"#10B981",fontWeight:700}}>{cont?cont.numero:"Sin contrato"}</span>
              {cont&&<span style={{fontSize:10,color:"#3B82F6",fontWeight:700}}>{pct}%</span>}
            </div>
            {cont&&<div style={{height:2,background:"var(--bdr)",borderRadius:2,marginBottom:6}}><div style={{height:"100%",width:`${pct}%`,background:"#3B82F6",borderRadius:2}}/></div>}
            {embs.map(s=>{const cfg=STATUS_CONFIG[s.status]||STATUS_CONFIG["En Preparación"];return(
              <div key={s.id} style={{display:"flex",alignItems:"center",background:"var(--bg)",borderRadius:5,padding:"5px 10px",fontSize:11,marginBottom:3,gap:8}}>
                <span style={{color:"#0EA5E9",fontWeight:700,minWidth:100}}>{s.proforma||s.id}</span>
                <span style={{color:"var(--txt)",flex:1}}>{s.cliente}</span>
                <span style={{color:"#3B82F6",minWidth:70,textAlign:"right"}}>{(parseFloat(s.cantidadKg)||0).toLocaleString()} kg</span>
                <span style={{fontSize:9,color:cfg.color,background:cfg.bg,padding:"1px 6px",borderRadius:100,whiteSpace:"nowrap"}}>{s.status}</span>
              </div>
            );})}
          </div>);
        })}
      </>);
    }
    if(tipoReporte==="contratos"){
      if(contracts.length===0)return<div style={{textAlign:"center",color:"var(--txt3)",padding:"20px 0"}}>Sin contratos registrados</div>;
      return(<>
        <div style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,marginBottom:10}}>VISTA PREVIA · {contracts.length} CONTRATOS</div>
        {contracts.map(cont=>{
          const embsCont=shipments.filter(s=>(s.productosEmbarque||[]).some(l=>l.contratoId===cont.id)||s.contratoId===cont.id);
          const kgEmb=embsCont.reduce((a,s)=>a+(parseFloat(s.cantidadKg)||0),0);
          const kgTotal=(cont.productos||[]).reduce((a,p)=>a+(parseFloat(p.cantidadKg)||0),0);
          const pct=kgTotal>0?Math.min(100,Math.round((kgEmb/kgTotal)*100)):0;
          return(<div key={cont.id} style={{background:"var(--bg)",borderRadius:7,padding:"8px 10px",marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{fontSize:11,color:"#10B981",fontWeight:700}}>{cont.numero}</span>
              <span style={{fontSize:10,color:"var(--txt3)"}}>{cont.cliente}</span>
              <span style={{fontSize:10,color:"#3B82F6",fontWeight:700}}>{pct}%</span>
            </div>
            <div style={{height:2,background:"var(--bdr)",borderRadius:2,marginBottom:5}}><div style={{height:"100%",width:`${pct}%`,background:"#3B82F6",borderRadius:2}}/></div>
            {(cont.productos||[]).map(p=><div key={p.id||p.nombre} style={{fontSize:10,color:"var(--txt2)",padding:"1px 0"}}>▸ {p.nombre} · {parseFloat(p.cantidadKg||0).toLocaleString()} kg</div>)}
          </div>);
        })}
      </>);
    }
    if(tipoReporte==="clientes"){
      if(clients.length===0)return<div style={{textAlign:"center",color:"var(--txt3)",padding:"20px 0"}}>Sin clientes registrados</div>;
      return(<>
        <div style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,marginBottom:10}}>VISTA PREVIA · {clients.length} CLIENTES</div>
        {clients.map(c=><div key={c.id} style={{display:"flex",alignItems:"center",background:"var(--bg)",borderRadius:5,padding:"5px 10px",fontSize:11,marginBottom:3,gap:8}}>
          <span style={{color:"#0EA5E9",fontWeight:700,minWidth:150}}>{c.nombre}</span>
          <span style={{color:"var(--txt3)",flex:1}}>{c.email||"—"}</span>
          <span style={{color:"var(--txt3)"}}>{c.telefono||"—"}</span>
        </div>)}
      </>);
    }
    if(tipoReporte==="vencimientos"){
      const vRows=shipments.filter(s=>s.facturaNum&&s.vencimientoType&&s.fechaEstimada);
      if(vRows.length===0)return<div style={{textAlign:"center",color:"var(--txt3)",padding:"20px 0"}}>Sin vencimientos registrados</div>;
      return(<>
        <div style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,marginBottom:10}}>VISTA PREVIA · {vRows.length} VENCIMIENTOS</div>
        {vRows.map(s=>{const vf=calcVencFecha(s.fechaEstimada,s.vencimientoType);const dias=getDias(vf);const est=dias===null?"—":dias<0?"VENCIDA":dias<=10?"PRÓXIMA":"OK";return(
          <div key={s.id} style={{display:"flex",alignItems:"center",background:"var(--bg)",borderRadius:5,padding:"5px 10px",fontSize:11,marginBottom:3,gap:8}}>
            <span style={{color:"#0EA5E9",fontWeight:700,minWidth:100}}>{s.proforma||s.id}</span>
            <span style={{color:"var(--txt)",flex:1}}>{s.cliente}</span>
            <span style={{color:"var(--txt2)"}}>{vf||"—"}</span>
            <span style={{fontSize:9,fontWeight:700,color:dias!==null&&dias<0?"#EF4444":dias!==null&&dias<=10?"#F59E0B":"#10B981"}}>{est}</span>
          </div>
        );})}
      </>);
    }
    return null;
  };

  const canPrint = tipoReporte==="embarques"?filtered.length>0:tipoReporte==="contratos"?contracts.length>0:tipoReporte==="clientes"?clients.length>0:shipments.filter(s=>s.facturaNum).length>0;

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(3,6,12,0.92)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(10px)"}}>
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:16,width:640,maxHeight:"88vh",overflowY:"auto",padding:28,animation:"fadeUp 0.22s ease"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div><div style={{fontFamily:"'Daytona Condensed','Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:"var(--hdg)"}}>⎙ EXPORTAR</div><div style={{fontSize:10,color:"var(--txt3)",letterSpacing:2,marginTop:2}}>ELEGÍ QUÉ QUERÉS EXPORTAR</div></div>
          <button onClick={onClose} style={{color:"var(--txt3)",fontSize:20}}>✕</button>
        </div>
        {/* Selector de tipo de reporte */}
        <div style={{display:"flex",gap:6,marginBottom:16}}>
          {TIPOS.map(t=>(
            <button key={t.id} onClick={()=>setTipoReporte(t.id)} style={{flex:1,padding:"8px 6px",borderRadius:8,fontSize:10,fontFamily:"inherit",fontWeight:700,border:"1px solid",borderColor:tipoReporte===t.id?"#3B82F6":"var(--bdr)",background:tipoReporte===t.id?"rgba(59,130,246,0.15)":"var(--bg)",color:tipoReporte===t.id?"#60A5FA":"var(--txt3)",cursor:"pointer",transition:"all 0.15s"}}>
              {t.label}
            </button>
          ))}
        </div>
        {/* Filtros solo para embarques */}
        {tipoReporte==="embarques"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:16}}>
          <div><label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>CLIENTE</label><select value={fc} onChange={e=>setFc(e.target.value)} style={IST}>{cls.map(c=><option key={c} value={c}>{c}</option>)}</select></div>
          <div><label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>CONTRATO</label><select value={fk} onChange={e=>setFk(e.target.value)} style={IST}>{cts.map(c=><option key={c} value={c}>{c}</option>)}</select></div>
        </div>}
        <div style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:10,padding:16,marginBottom:16,maxHeight:320,overflowY:"auto"}}>
          {previewContent()}
        </div>
        <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
          <button onClick={onClose} style={{padding:"9px 20px",borderRadius:8,fontSize:12,fontFamily:"inherit",color:"var(--txt3)",background:"transparent",border:"1px solid var(--bdr)"}}>CANCELAR</button>
          {tipoReporte==="embarques"&&<button onClick={doExcel} disabled={filtered.length===0||xlsxLoading} style={{padding:"9px 18px",borderRadius:8,fontSize:12,fontFamily:"inherit",fontWeight:700,background:filtered.length===0?"rgba(16,185,129,0.08)":"linear-gradient(135deg,#10B981,#059669)",color:filtered.length===0?"#2A5A4A":"#fff",display:"flex",alignItems:"center",gap:6}}>
            {xlsxLoading?<span style={{width:11,height:11,border:"2px solid #fff",borderTopColor:"transparent",borderRadius:"50%",display:"inline-block",animation:"spin 0.7s linear infinite"}}/>:"⊞"} EXCEL
          </button>}
          <button onClick={doPrint} disabled={!canPrint} style={{padding:"9px 18px",borderRadius:8,fontSize:12,fontFamily:"inherit",fontWeight:700,background:!canPrint?"rgba(248,113,113,0.08)":"linear-gradient(135deg,#EF4444,#DC2626)",color:!canPrint?"#5A3A3A":"#fff"}}>⎙ PDF</button>
        </div>
      </div>
    </div>
  );
}

// ── Componente de línea de producto para el formulario de embarque ──
function ProductLineRow({line, idx, total, contracts, shipments, editingId, onUpdate, onRemove, clienteProductos, activeCo}) {
  const selCont = contracts.find(c=>c.id===line.contratoId);
  const prodOptions = selCont?.productos||[];

  // Compute saldo for selected product
  const getSaldo = (contId, prodNombre) => {
    if(!contId||!prodNombre) return null;
    const cont = contracts.find(c=>c.id===contId);
    if(!cont) return null;
    const prod = (cont.productos||[]).find(p=>p.nombre===prodNombre);
    if(!prod) return null;
    const kgTotal = parseFloat(prod.cantidadKg)||0;
    const kgYa = shipments.reduce((tot,s)=>{
      if(s.id===editingId) return tot;
      const ls = s.productosEmbarque||[];
      return tot + ls.filter(l=>l.contratoId===contId&&l.contratoProducto===prodNombre).reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
    },0);
    return Math.max(0, kgTotal - kgYa);
  };
  const saldo = getSaldo(line.contratoId, line.contratoProducto);

  return (
    <div style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:9,padding:12,marginBottom:8,position:"relative"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
        <div style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,fontWeight:700}}>LÍNEA {idx+1}</div>
        {total>1&&<button onClick={onRemove} style={{color:"#EF4444",fontSize:11,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:5,padding:"2px 8px"}}>✕</button>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        {/* Contrato */}
        <div>
          <label style={{fontSize:8,color:"var(--txt3)",letterSpacing:1.5,display:"block",marginBottom:4}}>CONTRATO</label>
          <select value={line.contratoId||""} onChange={e=>{
            onUpdate({...line,contratoId:e.target.value,contratoProducto:""});
          }} style={{width:"100%",background:"var(--bg)",border:"1px solid var(--bdr)",borderRadius:7,padding:"8px 10px",color:"var(--txt)",fontSize:11,fontFamily:"inherit"}}>
            <option value="">— Sin contrato —</option>
            {contracts.map(c=>{
              const kgEmb=shipments.reduce((tot,s)=>{
                if(s.id===editingId) return tot;
                const ls=s.productosEmbarque||[];
                return tot+ls.filter(l=>l.contratoId===c.id).reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
              },0);
              const saldoCont=Math.max(0,(c.productos||[]).reduce((a,p)=>a+(parseFloat(p.cantidadKg)||0),0)-kgEmb);
              const done=saldoCont<=0;
              return <option key={c.id} value={c.id} disabled={done}>{c.numero} · {c.cliente}{done?" (COMPLETO)":""}</option>;
            })}
          </select>
        </div>
        {/* Producto */}
        <div>
          <label style={{fontSize:8,color:"var(--txt3)",letterSpacing:1.5,display:"block",marginBottom:4}}>PRODUCTO *</label>
          {prodOptions.length>0?(
            <select value={line.contratoProducto||""} onChange={e=>onUpdate({...line,contratoProducto:e.target.value})} style={{width:"100%",background:"var(--bg)",border:"1px solid var(--bdr)",borderRadius:7,padding:"8px 10px",color:"var(--txt)",fontSize:11,fontFamily:"inherit"}}>
              <option value="">— Elegir —</option>
              {prodOptions.map(p=>{
                const s2=getSaldo(line.contratoId,p.nombre);
                const done=s2!==null&&s2<=0;
                return <option key={p.id} value={p.nombre} disabled={done}>{p.nombre}{s2!==null?` (${s2.toLocaleString()} kg)`:""}{done?" COMPLETO":""}</option>;
              })}
            </select>
          ):(
            activeCo==="co1"&&clienteProductos&&clienteProductos.length>0?(
              <select value={line.contratoProducto||""} onChange={e=>onUpdate({...line,contratoProducto:e.target.value})} style={{width:"100%",background:"var(--bg)",border:"1px solid var(--bdr)",borderRadius:7,padding:"8px 10px",color:"var(--txt)",fontSize:11,fontFamily:"inherit"}}>
                <option value="">— Seleccionar producto —</option>
                {clienteProductos.map(p=>(<option key={p} value={p}>{p}</option>))}
              </select>
            ):(
              <input value={line.contratoProducto||""} onChange={e=>onUpdate({...line,contratoProducto:e.target.value})} placeholder="Nombre del producto" style={{width:"100%",background:"var(--bg)",border:"1px solid var(--bdr)",borderRadius:7,padding:"8px 10px",color:"var(--txt)",fontSize:11,fontFamily:"inherit"}}/>
            )
          )}
          {saldo!==null&&<div style={{fontSize:8,marginTop:3,color:saldo>0?"#3B82F6":"#EF4444",fontWeight:700}}>Saldo: {saldo.toLocaleString()} kg</div>}
        </div>
        {/* KG */}
        <div>
          <label style={{fontSize:8,color:"var(--txt3)",letterSpacing:1.5,display:"block",marginBottom:4}}>CANTIDAD (KG) *</label>
          <input type="number" value={line.cantidadKg||""} onChange={e=>onUpdate({...line,cantidadKg:e.target.value})} placeholder="Ej: 25000" style={{width:"100%",background:"var(--bg)",border:"1px solid var(--bdr)",borderRadius:7,padding:"8px 10px",color:"var(--txt)",fontSize:11,fontFamily:"inherit"}}/>
          {saldo!==null&&parseFloat(line.cantidadKg)>saldo&&<div style={{fontSize:8,marginTop:3,color:"#EF4444",fontWeight:700}}>⚠ Excede saldo ({saldo.toLocaleString()} kg)</div>}
        </div>
      </div>
    </div>
  );
}

// ── Componente: botón autocompletar Hapag-Lloyd ─────────────────────────────
function HlagAutofillBtn({ booking, destino, onAutofill }) {
  const [st, setSt] = useState("idle"); // idle | loading | ok | error
  const [errMsg, setErrMsg] = useState("");

  async function handleClick() {
    setSt("loading"); setErrMsg("");
    try {
      const res = await fetch(`/api/hlag-track?booking=${encodeURIComponent(booking.trim())}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const events = Array.isArray(data) ? data : (data.events || []);
      if (!events.length) throw new Error("Sin eventos para esta reserva");

      const sorted = [...events].sort((a,b)=>new Date(a.eventDateTime)-new Date(b.eventDateTime));

      // Buque y salida: DEPA desde ARBUE
      const dep = sorted.find(e=>e.eventType==="TRANSPORT"&&e.transportEventTypeCode==="DEPA"&&e.transportCall?.UNLocationCode==="ARBUE");
      const buque = dep?.transportCall?.vessel?.vesselName || "";
      const fechaSalida = dep?.eventDateTime?.split("T")[0] || "";

      // ETA: último ARRI PLN
      const arris = sorted.filter(e=>e.eventType==="TRANSPORT"&&e.transportEventTypeCode==="ARRI"&&e.eventClassifierCode==="PLN");
      const arr = arris[arris.length-1];
      const fechaEstimada = arr?.eventDateTime?.split("T")[0] || "";

      onAutofill({ buque, fechaSalida, fechaEstimada });
      setSt("ok");
      setTimeout(()=>setSt("idle"), 3000);
    } catch(e) {
      setErrMsg(e.message);
      setSt("error");
      setTimeout(()=>setSt("idle"), 4000);
    }
  }

  const BG = {idle:"#f97316", loading:"#555", ok:"#22c55e", error:"#ef4444"}[st];
  const LABEL = {idle:"🔍 Autocompletar", loading:"⟳ Consultando...", ok:"✓ Datos cargados", error:"✗ Error"}[st];

  return (
    <div style={{display:"flex",flexDirection:"column",gap:3,flexShrink:0}}>
      <button type="button" onClick={handleClick} disabled={st==="loading"}
        style={{padding:"7px 13px",borderRadius:6,border:"none",background:BG,color:"#fff",
                fontWeight:700,fontSize:11,cursor:st==="loading"?"not-allowed":"pointer",
                whiteSpace:"nowrap",transition:"background .3s",letterSpacing:"0.04em",fontFamily:"inherit"}}>
        {LABEL}
      </button>
      {st==="error"&&<span style={{fontSize:10,color:"#f87171",maxWidth:160}}>{errMsg}</span>}
    </div>
  );
}

export default function App() {
  const [dark,setDark]=useState(true);
  const [authed,setAuthed]=useState(()=>sessionStorage.getItem("exportrak-auth")==="1");
  const [companies,setCompanies]=useState([]);
  const [activeCo,setActiveCo]=useState("co1");
  const [showAddCo,setShowAddCo]=useState(false);
  const [newCoForm,setNewCoForm]=useState({name:"",direccion:"",cuit:"",email:"",web:""});
  const [shipments,setShipments]=useState([]);
  const [maerskModal,setMaerskModal]=useState(null);
  const [contracts,setContracts]=useState([]);
  const [clients,setClients]=useState([]);
  const [bankAccounts,setBankAccounts]=useState([]);
  const [proformas,setProformas]=useState([]);
  const [selected,setSelected]=useState(null);
  const [filterStatus,setFilter]=useState("Todos");
  const [search,setSearch]=useState("");
  const [showForm,setShowForm]=useState(false);
  const [form,setForm]=useState(EMPTY_FORM);
  const [editingId,setEditingId]=useState(null);
  const [tab,setTab]=useState("lista");
  const [mounted,setMounted]=useState(false);
  const [storageReady,setStorageReady]=useState(false);
  const [contratoError,setContratoError]=useState(null);
  const [showExport,setShowExport]=useState(false);
  const [showContractForm,setShowContractForm]=useState(false);
  const [contractForm,setContractForm]=useState(EMPTY_CONTRACT);
  const [editingContractId,setEditingContractId]=useState(null);
  const [noticeData,setNoticeData]=useState(null);
  const [quickNewClient,setQuickNewClient]=useState(false);
  const [newClientForm,setNewClientForm]=useState({...EMPTY_CLIENT});
  const [showProformaForm,setShowProformaForm]=useState(false);
  const [proformaForm,setProformaForm]=useState(EMPTY_PF());
  const [editingPfId,setEditingPfId]=useState(null);
  const [showBankModal,setShowBankModal]=useState(false);

  useEffect(()=>{
    async function init(){
      const rows=await sbGet("/rest/v1/companies?select=*&order=id");
      if(rows&&rows.length){
        // Merge stored data with INIT_COMPANIES to ensure full data is always present
        const merged=rows.map(r=>{
          const init=INIT_COMPANIES.find(c=>c.id===r.id);
          if(init){
            const full={...dbToCo(r),direccion:r.direccion||init.direccion,cuit:r.cuit||init.cuit,email:r.email||init.email,web:r.web||init.web,name:init.name};
            sbUpsert("companies",coToDb(full));
            return full;
          }
          return dbToCo(r);
        });
        setCompanies(merged);
      }
      else{
        setCompanies(INIT_COMPANIES);
        for(const c of INIT_COMPANIES) await sbUpsert("companies",coToDb(c));
      }
    }
    init();
  },[]);

  useEffect(()=>{
    if(!companies.length)return;
    setStorageReady(false);setSelected(null);
    async function load(){
      const [ss,sk,sc,sb,spf]=await Promise.all([
        sbGet(`/rest/v1/shipments?company_id=eq.${activeCo}&select=*&order=id`),
        sbGet(`/rest/v1/contracts?company_id=eq.${activeCo}&select=*&order=id`),
        sbGet(`/rest/v1/clients?company_id=eq.${activeCo}&select=*&order=nombre`),
        sbGet(`/rest/v1/bank_accounts?company_id=eq.${activeCo}&select=*&order=id`),
        sbGet(`/rest/v1/proformas?company_id=eq.${activeCo}&select=*&order=id`),
      ]);
      const loadedShipments = ss&&ss.length?ss.map(dbToShip):[];
      setShipments(loadedShipments);
      // Auto-sync Maersk tracking for active shipments
      const maerskShipments = loadedShipments.filter(s=>
        s.bl && s.naviera==="Maersk" && s.status!=="Entregado"
      );
      const hlagShipments = loadedShipments.filter(s=>
        s.bl && s.naviera==="Hapag-Lloyd" && s.status!=="Entregado"
      );
      const cmaShipments = loadedShipments.filter(s=>
        s.bl && s.naviera==="CMA CGM" && s.status!=="Entregado"
      );
      if(maerskShipments.length>0){
        (async()=>{
          for(const s of maerskShipments){
            try{
              const result = await trackMaersk(s.bl);
              if(!result.error){
                const updates = {};
                if(result.eta && result.eta!==s.fechaEstimada) updates.fechaEstimada=result.eta;
                if(result.arrived) updates.status="Entregado";
                if(Object.keys(updates).length>0){
                  const updated = {...s,...updates};
                  setShipments(p=>p.map(x=>x.id===s.id?updated:x));
                  sbUpsert("shipments",shipToDb(updated,s.company_id||activeCo));
                }
              }
            } catch(e){}
          }
        })();
      }
      if(hlagShipments.length>0){
        (async()=>{
          for(const s of hlagShipments){
            try{
              const result=await trackHlag(s.bl);
              if(!result.error){
                const updates={};
                if(result.eta&&result.eta!==s.fechaEstimada) updates.fechaEstimada=result.eta;
                if(result.arrived) updates.status="Entregado";
                if(Object.keys(updates).length>0){
                  const updated={...s,...updates};
                  setShipments(p=>p.map(x=>x.id===s.id?updated:x));
                  sbUpsert("shipments",shipToDb(updated,s.company_id||activeCo));
                }
              }
            } catch(e){}
          }
        })();
      }
      if(cmaShipments.length>0){
        (async()=>{
          for(const s of cmaShipments){
            try{
              const result=await trackCma(s.bl);
              if(!result.error){
                const updates={};
                if(result.eta&&result.eta!==s.fechaEstimada) updates.fechaEstimada=result.eta;
                if(result.arrived) updates.status="Entregado";
                if(Object.keys(updates).length>0){
                  const updated={...s,...updates};
                  setShipments(p=>p.map(x=>x.id===s.id?updated:x));
                  sbUpsert("shipments",shipToDb(updated,s.company_id||activeCo));
                }
              }
            } catch(e){}
          }
        })();
      }
      setContracts(sk&&sk.length?sk.map(dbToCont):[]);
      setClients(sc&&sc.length?sc.map(dbToClient):[]);
      setBankAccounts(sb&&sb.length?sb.map(dbToBank):[]);
      setProformas(spf&&spf.length?spf.map(dbToPf).filter(Boolean):[]);
      setStorageReady(true);setMounted(true);
    }
    load();
  },[activeCo,companies.length]);

  const filtered=shipments.filter(s=>{
    const effectiveStatus=calcStatus(s.fechaSalida,s.fechaEstimada);const ok=filterStatus==="Todos"||effectiveStatus===filterStatus;
    const q=search.toLowerCase();
    const prodStr=(s.productosEmbarque||[]).map(l=>l.contratoProducto||'').join(' ').toLowerCase();
    return ok&&(!q||s.id.toLowerCase().includes(q)||s.cliente.toLowerCase().includes(q)||s.destino.toLowerCase().includes(q)||(s.producto||"").toLowerCase().includes(q)||prodStr.includes(q)||(s.proforma||"").toLowerCase().includes(q)||(s.facturaNum||"").toLowerCase().includes(q)||(s.bl||"").toLowerCase().includes(q)||(s.naviera||"").toLowerCase().includes(q)||(s.buque||"").toLowerCase().includes(q)||(s.contratoId||"").toLowerCase().includes(q)||(s.notas||"").toLowerCase().includes(q)||(s.emailCliente||"").toLowerCase().includes(q));
  });
  const alertCount=shipments.filter(s=>getAlerta(getDias(s.fechaEstimada),s.status)).length;
  const vencCount=shipments.filter(s=>{const d=getDias(calcVencFecha(s.fechaEstimada,s.vencimientoType));return d!==null&&d<=10&&d>=0;}).length;

  // KG embarcado por contrato — usa productosEmbarque
  function getKgEmb(cId){
    return shipments.reduce((tot,s)=>{
      const ls=s.productosEmbarque||[];
      return tot+ls.filter(l=>l.contratoId===cId).reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
    },0);
  }
  function getKgEmbByProduct(cId,prodNombre){
    return shipments.reduce((tot,s)=>{
      const ls=s.productosEmbarque||[];
      return tot+ls.filter(l=>l.contratoId===cId&&l.contratoProducto===prodNombre).reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
    },0);
  }

  function openNew(){setForm({...EMPTY_FORM,productosEmbarque:[{...EMPTY_PE()}]});setEditingId(null);setContratoError(null);setShowForm(true);}
  function openEdit(s){
    const pe=s.productosEmbarque&&s.productosEmbarque.length?s.productosEmbarque:[{...EMPTY_PE(),contratoId:s.contratoId||'',contratoProducto:s.contratoProducto||s.producto||'',cantidadKg:s.cantidadKg||''}];
    setForm({...s,productosEmbarque:pe});
    setEditingId(s.id);setContratoError(null);setShowForm(true);setSelected(null);
  }
  function deleteSh(id){setShipments(p=>p.filter(s=>s.id!==id));setSelected(null);sbDelete("shipments",id);}
  function markCobrado(id){
    setShipments(p=>p.map(s=>s.id===id?{...s,estadoCobro:s.estadoCobro==="cobrado"?"pendiente":"cobrado"}:s));
    const s=shipments.find(x=>x.id===id);
    if(s){const updated={...s,estadoCobro:s.estadoCobro==="cobrado"?"pendiente":"cobrado"};sbUpsert("shipments",shipToDb(updated,activeCo));}
  }

  function updateLine(idx, newLine){
    setForm(p=>({...p,productosEmbarque:p.productosEmbarque.map((l,i)=>i===idx?newLine:l)}));
    setContratoError(null);
  }
  function addLine(){
    setForm(p=>({...p,productosEmbarque:[...p.productosEmbarque,{...EMPTY_PE()}]}));
  }
  function removeLine(idx){
    setForm(p=>({...p,productosEmbarque:p.productosEmbarque.filter((_,i)=>i!==idx)}));
  }

  function saveForm(){
    if(!form.cliente||!form.destino){setContratoError("Cliente y Destino son obligatorios.");return;}
    const lines=(form.productosEmbarque||[]).filter(l=>l.cantidadKg&&parseFloat(l.cantidadKg)>0);
    if(lines.length===0){setContratoError("Agregá al menos una línea de producto con kg.");return;}

    for(const line of lines){
      if(!line.contratoProducto){setContratoError("Cada línea debe tener un producto.");return;}
      if(line.contratoId){
        const cont=contracts.find(c=>c.id===line.contratoId);
        if(cont){
          const prod=(cont.productos||[]).find(p=>p.nombre===line.contratoProducto);
          if(prod){
            const kgTotal=parseFloat(prod.cantidadKg)||0;
            const kgYa=shipments.filter(s=>s.id!==editingId).reduce((tot,s)=>{
              const ls=s.productosEmbarque||[];
              return tot+ls.filter(l=>l.contratoId===line.contratoId&&l.contratoProducto===line.contratoProducto).reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
            },0);
            const saldo=kgTotal-kgYa;
            const kgEste=parseFloat(line.cantidadKg)||0;
            if(kgEste>saldo){setContratoError(`"${line.contratoProducto}" (${cont.numero}): excede saldo de ${saldo.toLocaleString()} kg.`);return;}
          }
        }
      }
    }

    setContratoError(null);
    const totalKg=lines.reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
    const firstLine=lines[0]||{};
    const productoDisplay=lines.map(l=>l.contratoProducto||'').filter(Boolean).join(' / ')||form.producto||'';
    const isNew=!editingId;
    const finalForm={
      ...form,
      productosEmbarque:lines,
      cantidadKg:totalKg,
      contratoId:firstLine.contratoId||'',
      contratoProducto:firstLine.contratoProducto||'',
      producto:productoDisplay,
      status:calcStatus(form.fechaSalida,form.fechaEstimada)
    };
    let savedId=editingId;
    if(editingId){setShipments(p=>p.map(s=>s.id===editingId?{...s,...finalForm}:s));}
    else{savedId=`EXP-${new Date().getFullYear()}-${String(Math.floor(Math.random()*9000)+1000)}`;setShipments(p=>[{...finalForm,id:savedId},...p]);}
    sbUpsert("shipments",shipToDb({...finalForm,id:savedId},activeCo));
    // Auto-sync Maersk tracking for this shipment if applicable
    if(finalForm.bl&&finalForm.naviera==="Maersk"&&finalForm.status!=="Entregado"){
      (async()=>{
        try{
          const result=await trackMaersk(finalForm.bl);
          if(!result.error){
            const updates={};
            if(result.eta&&result.eta!==finalForm.fechaEstimada) updates.fechaEstimada=result.eta;
            if(result.arrived) updates.status="Entregado";
            if(Object.keys(updates).length>0){
              const updated={...finalForm,id:savedId,...updates};
              setShipments(p=>p.map(x=>x.id===savedId?updated:x));
              sbUpsert("shipments",shipToDb(updated,activeCo));
            }
          }
        }catch(e){}
      })();
    }
    // Auto-sync Hapag-Lloyd tracking for this shipment if applicable
    if(finalForm.bl&&finalForm.naviera==="CMA CGM"&&finalForm.status!=="Entregado"){
      (async()=>{
        try{
          const result=await trackCma(finalForm.bl);
          if(!result.error){
            const updates={};
            if(result.eta&&result.eta!==finalForm.fechaEstimada) updates.fechaEstimada=result.eta;
            if(result.arrived) updates.status="Entregado";
            if(Object.keys(updates).length>0){
              const updated={...finalForm,id:savedId,...updates};
              setShipments(p=>p.map(x=>x.id===savedId?updated:x));
              sbUpsert("shipments",shipToDb(updated,activeCo));
            }
          }
        } catch(e){}
      })();
    }
   if(finalForm.bl&&finalForm.naviera==="Hapag-Lloyd"&&finalForm.status!=="Entregado"){
      (async()=>{
        try{
          const result=await trackHlag(finalForm.bl, finalForm.destino||"");
          if(!result.error){
            const updates={};
            if(result.eta&&result.eta!==finalForm.fechaEstimada) updates.fechaEstimada=result.eta;
            if(result.buque&&!finalForm.buque) updates.buque=result.buque;
            if(result.fechaSalida&&!finalForm.fechaSalida) updates.fechaSalida=result.fechaSalida;
            if(result.arrived) updates.status="Entregado";
            if(Object.keys(updates).length>0){
              const updated={...finalForm,id:savedId,...updates};
              setShipments(p=>p.map(x=>x.id===savedId?updated:x));
              sbUpsert("shipments",shipToDb(updated,activeCo));
            }
          }
        }catch(e){}
      })();
    }
    setShowForm(false);
    if(isNew&&form.emailCliente){
      const sender=companies.find(c=>c.id===activeCo)?.senderEmail||"";
      setTimeout(()=>setNoticeData({shipment:{...finalForm,id:savedId},senderEmail:sender}),200);
    }
  }

  function openNewContract(){setContractForm(EMPTY_CONTRACT);setEditingContractId(null);setShowContractForm(true);}
  function openEditContract(c){setContractForm({...c});setEditingContractId(c.id);setShowContractForm(true);}
  function deleteContract(id){setContracts(p=>p.filter(c=>c.id!==id));sbDelete("contracts",id);}
  function saveContract(){
    if(!contractForm.numero||!contractForm.cliente)return;
    const prods=(contractForm.productos||[]).filter(p=>p.nombre&&p.cantidadKg);
    if(prods.length===0){alert("Agregá al menos un producto con nombre y cantidad.");return;}
    const id=contractForm.numero;
    const finalContract={...contractForm,productos:prods,id};
    if(editingContractId){setContracts(p=>p.map(c=>c.id===editingContractId?finalContract:c));}
    else{if(contracts.find(c=>c.id===id)){alert("Ya existe ese número de contrato.");return;}setContracts(p=>[finalContract,...p]);}
    sbUpsert("contracts",contToDb(finalContract,activeCo));
    setShowContractForm(false);
  }
  function saveClient(client,editId){
    if(editId){setClients(p=>p.map(c=>c.id===editId?client:c));}
    else{setClients(p=>[...p,client]);}
    sbUpsert("clients",clientToDb(client,activeCo));
  }
  function deleteClient(id){setClients(p=>p.filter(c=>c.id!==id));sbDelete("clients",id);}

  // ── Proformas ──────────────────────────────────────────
  function openNewProforma(){setProformaForm({...EMPTY_PF(),id:`PF-${new Date().getFullYear()}-${String(Math.floor(Math.random()*9000)+1000)}`});setEditingPfId(null);setShowProformaForm(true);}
  function openEditProforma(p){setProformaForm({...p});setEditingPfId(p.id);setShowProformaForm(true);}
  function saveProforma(){
    const pf=proformaForm;
    const id=pf.id||`PF-${new Date().getFullYear()}-${String(Math.floor(Math.random()*9000)+1000)}`;
    const finalPf={...pf,id};
    if(editingPfId){setProformas(p=>p.map(x=>x.id===editingPfId?finalPf:x));}
    else{setProformas(p=>[finalPf,...p]);}
    sbUpsert("proformas",pfToDb(finalPf,activeCo));
    setShowProformaForm(false);
  }
  function deleteProforma(id){setProformas(p=>p.filter(x=>x.id!==id));sbDelete("proformas",id);}

  // ── Bank Accounts ──────────────────────────────────────
  function saveBankAccount(bank,editId){
    if(editId){setBankAccounts(p=>p.map(b=>b.id===editId?bank:b));}
    else{setBankAccounts(p=>[...p,bank]);}
    sbUpsert("bank_accounts",bankToDb(bank,activeCo)).then?.(()=>{});
    setTimeout(async()=>{const sb=await sbGet(`/rest/v1/bank_accounts?company_id=eq.${activeCo}&select=*&order=id`);if(sb&&sb.length)setBankAccounts(sb.map(dbToBank));},800);
  }
  function deleteBankAccount(id){setBankAccounts(p=>p.filter(b=>b.id!==id));sbDelete("bank_accounts",id);}

  function addCompany(){
    if(!newCoForm.name.trim())return;
    const id=`co-${Date.now()}`;
    const newCo={id,name:newCoForm.name.trim(),senderEmail:"",direccion:newCoForm.direccion,cuit:newCoForm.cuit,email:newCoForm.email,web:newCoForm.web};
    const updated=[...companies,newCo];
    setCompanies(updated);
    sbUpsert("companies",coToDb(newCo));
    setNewCoForm({name:"",direccion:"",cuit:"",email:""});setShowAddCo(false);setActiveCo(id);
  }

  const D={bg:"#080D14",bg2:"#0D1520",bg3:"#0A1420",bdr:"#1A2D45",bdr2:"#0D1A28",txt:"#C8D8E8",txt2:"#94A3B8",txt3:"#4A6A8A",hdg:"#E2EEF8"};
  const L={bg:"#F1F5F9",bg2:"#FFFFFF",bg3:"#F8FAFC",bdr:"#CBD5E1",bdr2:"#E2E8F0",txt:"#1E293B",txt2:"#475569",txt3:"#94A3B8",hdg:"#0F172A"};
  const T=dark?D:L;
  const IST={width:"100%",background:T.bg,border:`1px solid ${T.bdr}`,borderRadius:8,padding:"9px 12px",color:T.txt,fontSize:12,fontFamily:"'Daytona','Barlow',sans-serif"};
  const sel=selected?shipments.find(s=>s.id===selected):null;

  if(!authed) return <LoginScreen onLogin={()=>setAuthed(true)} dark={dark}/>;

  return (
    <div style={{fontFamily:"'Daytona','Barlow',sans-serif",background:`var(--bg)`,minHeight:"100vh",width:"100%",color:"var(--txt)",opacity:mounted?1:0,transition:"opacity 0.5s"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800&family=Barlow:wght@400;600;700&display=swap');
        :root{--bg:${T.bg};--bg2:${T.bg2};--bg3:${T.bg3};--bdr:${T.bdr};--bdr2:${T.bdr2};--txt:${T.txt};--txt2:${T.txt2};--txt3:${T.txt3};--hdg:${T.hdg}}
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:var(--bg2)}::-webkit-scrollbar-thumb{background:var(--bdr);border-radius:2px}
        button{cursor:pointer;border:none;background:none;font-family:inherit}select,input,textarea{outline:none}
        .srow:hover{background:rgba(14,165,233,0.05)!important}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        @keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
      `}</style>

      {/* ── Header ── */}
      <div style={{background:"var(--bg2)",borderBottom:"1px solid var(--bdr)",position:"sticky",top:0,zIndex:100,backdropFilter:"blur(12px)"}}>
        <div style={{padding:"0 20px",display:"flex",alignItems:"center",gap:3,borderBottom:"1px solid var(--bdr)",overflowX:"auto",minHeight:38}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginRight:10,flexShrink:0}}>
            <div style={{width:22,height:22,borderRadius:5,background:"linear-gradient(135deg,#0EA5E9,#0369A1)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11}}>⛵</div>
            <div style={{fontFamily:"'Daytona Condensed','Barlow Condensed',sans-serif",fontWeight:800,fontSize:10,color:"var(--hdg)",letterSpacing:1,whiteSpace:"nowrap"}}>EXPORTRAK</div>
          </div>
          {companies.map(co=>(
            <button key={co.id} onClick={()=>{setActiveCo(co.id);setTab("lista");setSelected(null);}} style={{padding:"5px 13px",borderRadius:5,fontSize:11,fontFamily:"inherit",fontWeight:700,whiteSpace:"nowrap",background:activeCo===co.id?"rgba(14,165,233,0.15)":"transparent",color:activeCo===co.id?"#0EA5E9":"var(--txt3)",border:`1px solid ${activeCo===co.id?"#0EA5E9":"transparent"}`,transition:"all 0.2s"}}>{co.name}</button>
          ))}
          <button onClick={()=>setShowAddCo(true)} title="Agregar empresa" style={{padding:"3px 9px",borderRadius:5,fontSize:13,color:"var(--txt3)",border:"1px dashed var(--bdr)",flexShrink:0,marginLeft:2}}>+</button>
        </div>
        <div style={{padding:"0 20px",display:"flex",alignItems:"center",justifyContent:"space-between",height:50}}>
          <div style={{display:"flex",gap:3}}>
            {[{id:"lista",label:"LISTA"},{id:"contratos",label:"CONTRATOS"},{id:"proformas",label:"PROFORMAS"},{id:"clientes",label:"CLIENTES"},{id:"vencimientos",label:"VENCIMIENTOS",badge:vencCount}].map(t=>(
              <button key={t.id} onClick={()=>setTab(t.id)} style={{position:"relative",padding:"5px 13px",borderRadius:6,fontSize:10,fontFamily:"inherit",letterSpacing:0.5,fontWeight:700,background:tab===t.id?"rgba(14,165,233,0.15)":"transparent",color:tab===t.id?"#0EA5E9":"var(--txt3)",border:`1px solid ${tab===t.id?"#0EA5E9":"transparent"}`,transition:"all 0.2s"}}>
                {t.label}
                {t.badge>0&&<span style={{position:"absolute",top:-4,right:-4,background:"#EF4444",color:"#fff",borderRadius:100,fontSize:8,fontWeight:800,padding:"1px 4px",minWidth:14,textAlign:"center"}}>{t.badge}</span>}
              </button>
            ))}
          </div>
          <div style={{display:"flex",gap:7,alignItems:"center"}}>
            <button onClick={()=>setDark(d=>!d)} title={dark?"Modo claro":"Modo oscuro"} style={{padding:"5px 9px",borderRadius:7,fontSize:13,background:"var(--bg3)",border:"1px solid var(--bdr)",color:"var(--txt2)"}}>{dark?"☀":"🌙"}</button>
            <button onClick={()=>{sessionStorage.removeItem("exportrak-auth");setAuthed(false);}} title="Cerrar sesión" style={{padding:"5px 9px",borderRadius:7,fontSize:12,background:"var(--bg3)",border:"1px solid var(--bdr)",color:"var(--txt3)",fontFamily:"inherit"}}>⎋ Salir</button>
            <button onClick={()=>setShowExport(true)} style={{padding:"6px 13px",borderRadius:7,fontSize:11,fontFamily:"inherit",fontWeight:700,background:"rgba(248,113,113,0.12)",color:"#F87171",border:"1px solid rgba(248,113,113,0.3)"}}>⎙ EXPORTAR</button>
            <button onClick={openNew} style={{background:"linear-gradient(135deg,#0EA5E9,#0369A1)",color:"#fff",padding:"6px 15px",borderRadius:7,fontSize:11,fontFamily:"inherit",fontWeight:700,boxShadow:"0 0 12px rgba(14,165,233,0.25)"}}>+ NUEVO EMBARQUE</button>
          </div>
        </div>
      </div>

      {/* ── Tabs ── */}
      {tab==="vencimientos"&&<VencimientosTab shipments={shipments} senderEmail={companies.find(c=>c.id===activeCo)?.senderEmail||""} onMarkCobrado={markCobrado}/>}
      {tab==="clientes"&&<ClientesTab clients={clients} onSave={saveClient} onDelete={deleteClient} activeCo={activeCo}/>}
      {tab==="contratos"&&<ContratosTab contracts={contracts} shipments={shipments} getKgEmb={getKgEmb} onNew={openNewContract} onEdit={openEditContract} onDelete={deleteContract}/>}
      {tab==="proformas"&&<ProformasTab proformas={proformas} contracts={contracts} bankAccounts={bankAccounts} company={companies.find(c=>c.id===activeCo)||{}} onNew={openNewProforma} onEdit={openEditProforma} onDelete={deleteProforma} onPrint={(p,bank)=>printProformaDoc(p,companies.find(c=>c.id===activeCo)||{},bank)}/>}
      {tab==="lista"&&(
        <div style={{display:"flex",height:"calc(100vh - 88px)"}}>
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
            {alertCount>0&&<div style={{padding:"8px 18px",borderBottom:"1px solid var(--bdr)"}}><AlertBanner shipments={shipments}/></div>}
            <div style={{padding:"8px 18px",display:"flex",gap:7,alignItems:"center",borderBottom:"1px solid var(--bdr)",flexWrap:"wrap"}}>
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar embarque, cliente, factura..." style={{flex:1,minWidth:150,background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:7,padding:"6px 12px",color:"var(--txt)",fontSize:11,fontFamily:"inherit"}}/>
              {["Todos","En Preparación","En Tránsito","Entregado"].map(st=>(
                <button key={st} onClick={()=>setFilter(st)} style={{padding:"4px 9px",borderRadius:5,fontSize:9,fontFamily:"inherit",fontWeight:700,background:filterStatus===st?(STATUS_CONFIG[st]?.bg||"rgba(148,163,184,0.12)"):"transparent",color:filterStatus===st?(STATUS_CONFIG[st]?.color||"#94A3B8"):"var(--txt3)",border:`1px solid ${filterStatus===st?(STATUS_CONFIG[st]?.color||"#94A3B8"):"transparent"}`,transition:"all 0.2s"}}>{st.toUpperCase()}</button>
              ))}
            </div>
            <div style={{flex:1,overflowY:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr style={{borderBottom:"1px solid var(--bdr)"}}>
                  {(activeCo==="co1"?[
                    {l:"EMBARQUE",w:130},{l:"CLIENTE",w:160},{l:"DESTINO",w:130},
                    {l:"BOOKING",w:110},{l:"CONT.",w:50},{l:"KG TOTAL",w:80},
                    {l:"DOCS",w:90},{l:"TRAYECTO",w:180},{l:"",w:30}
                  ]:[
                    {l:"EMBARQUE",w:120},{l:"CLIENTE",w:150},{l:"DESTINO",w:120},
                    {l:"PRODUCTOS",w:130},{l:"BOOKING",w:100},{l:"CONT.",w:50},
                    {l:"KG TOTAL",w:80},{l:"DOCS",w:90},{l:"TRAYECTO",w:170},{l:"",w:30}
                  ]).map(h=>(
                    <th key={h.l} style={{padding:"8px 11px",textAlign:"left",fontSize:9,color:"var(--txt3)",letterSpacing:2,fontWeight:700,whiteSpace:"nowrap",minWidth:h.w}}>{h.l}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {filtered.map((s,i)=>{
                    const alerta=getAlerta(getDias(s.fechaEstimada),s.status);
                    const isActive=selected===s.id;
                    const dc=DOC_COLORS[s.estadoDocs]||DOC_COLORS["Pendiente"];
                    const lines=s.productosEmbarque||[];
                    const totalKg=lines.reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0)||(parseFloat(s.cantidadKg)||0);
                    return (
                      <tr key={s.id} className="srow" onClick={()=>setSelected(isActive?null:s.id)} style={{borderBottom:"1px solid var(--bdr2)",background:isActive?"rgba(14,165,233,0.07)":"transparent",cursor:"pointer",animation:`fadeUp 0.28s ease ${i*0.04}s both`}}>
                        <td style={{padding:"10px 11px"}}>
                          <div style={{fontSize:14,color:"var(--hdg)",fontWeight:700}}>{s.proforma||s.id}</div>
                          <div style={{fontSize:11,color:"var(--txt3)"}}>{s.id}</div>
                          {alerta&&<span style={{fontSize:8,color:alerta.color,background:alerta.bg,padding:"1px 5px",borderRadius:100,fontWeight:700,border:`1px solid ${alerta.color}40`,display:"inline-block",marginTop:2,animation:alerta.nivel==="rojo"?"pulse 1.5s infinite":"none"}}>{alerta.emoji} {getDias(s.fechaEstimada)}d</span>}
                        </td>
                        <td style={{padding:"10px 11px",fontSize:14,color:"var(--txt)",fontWeight:500}}>{s.cliente}</td>
                        <td style={{padding:"10px 11px",fontSize:13,color:"var(--txt2)"}}>{s.destino}</td>
                        {/* Productos / Booking column */}
                        {activeCo==="co1"?(
                          <td style={{padding:"10px 11px",fontSize:12,color:"var(--txt2)",fontWeight:600}}>{s.bl||"—"}</td>
                        ):(
                          <td style={{padding:"10px 11px",maxWidth:180}}>
                            {lines.length>0?(
                              <div style={{display:"flex",flexDirection:"column",gap:2}}>
                                {lines.map((l,li)=>(
                                  <div key={l.id} style={{fontSize:10,color:"var(--txt2)",display:"flex",alignItems:"center",gap:4}}>
                                    <span style={{width:5,height:5,borderRadius:"50%",background:"#3B82F6",flexShrink:0,display:"inline-block"}}/>
                                    <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.contratoProducto||'—'}</span>
                                  </div>
                                ))}
                              </div>
                            ):(
                              <span style={{fontSize:11,color:"var(--txt2)"}}>{s.producto||"—"}</span>
                            )}
                          </td>
                        )}
                        {activeCo!=="co1"&&(
                          <td style={{padding:"10px 11px",fontSize:12,color:"var(--txt2)",fontWeight:600}}>{s.bl||"—"}</td>
                        )}
                        <td style={{padding:"10px 11px",fontSize:13,color:"var(--hdg)",fontWeight:700,textAlign:"center"}}>{s.volumen||"—"}</td>
                        <td style={{padding:"10px 11px"}}>
                          <div style={{fontSize:13,color:"#3B82F6",fontWeight:700}}>{totalKg.toLocaleString()}</div>
                          <div style={{fontSize:9,color:"var(--txt3)"}}>kg</div>
                        </td>
                        <td style={{padding:"10px 11px"}}><span style={{background:dc.bg,color:dc.color,padding:"3px 8px",borderRadius:100,fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>{s.estadoDocs||"Pendiente"}</span></td>
                        <td style={{padding:"10px 11px",minWidth:190}}><JourneyBar s={s}/></td>
                        <td style={{padding:"10px 7px"}}><button onClick={e=>{e.stopPropagation();openEdit(s);}} style={{color:"var(--txt3)",fontSize:13,padding:"2px 5px"}}>✎</button></td>
                      </tr>
                    );
                  })}
                  {filtered.length===0&&<tr><td colSpan={9} style={{padding:40,textAlign:"center",color:"var(--txt3)",fontSize:13}}>No se encontraron embarques</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          {sel&&(
            <div style={{width:390,borderLeft:"1px solid var(--bdr)",background:"var(--bg2)",overflowY:"auto",animation:"slideIn 0.28s ease",flexShrink:0}}>
              <DetailPanel s={sel} onClose={()=>setSelected(null)} onEdit={openEdit} onDelete={deleteSh} senderEmail={companies.find(c=>c.id===activeCo)?.senderEmail||""} activeCo={activeCo}/>
            </div>
          )}
        </div>
      )}

      {/* ── Modal Nuevo Embarque ── */}
      {showForm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(3,6,12,0.88)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}}>
          <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:16,width:760,maxHeight:"93vh",overflowY:"auto",padding:28,animation:"fadeUp 0.22s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div>
                <div style={{fontFamily:"'Daytona Condensed','Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:"var(--hdg)"}}>{editingId?"EDITAR EMBARQUE":"NUEVO EMBARQUE"}</div>
                <div style={{fontSize:9,color:"var(--txt3)",letterSpacing:2}}>{editingId||"REGISTRAR NUEVA EXPORTACIÓN"}</div>
              </div>
              <button onClick={()=>setShowForm(false)} style={{color:"var(--txt3)",fontSize:20}}>✕</button>
            </div>

            {/* ── Sección: Info general ── */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
              <div>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>PROFORMA</label>
                <input value={form.proforma||""} onChange={e=>setForm(p=>({...p,proforma:e.target.value}))} placeholder="Ej: PRO-2026-001" style={IST}/>
              </div>
              <div>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>CLIENTE *</label>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <input list="cli-list" value={form.cliente} onChange={e=>{
                    setForm(p=>({...p,cliente:e.target.value}));
                    const found=clients.find(c=>c.nombre===e.target.value);
                    if(found)setForm(p=>({...p,cliente:e.target.value,emailCliente:found.email||p.emailCliente}));
                  }} placeholder="Escribir o elegir..." style={{...IST,flex:1}}/>
                  <button type="button" onClick={()=>{setNewClientForm({...EMPTY_CLIENT});setQuickNewClient(true);}} title="Nuevo cliente" style={{width:28,height:28,borderRadius:6,background:"rgba(16,185,129,0.15)",border:"1px solid rgba(16,185,129,0.4)",color:"#10B981",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>+</button>
                </div>
                <datalist id="cli-list">{clients.map(c=><option key={c.id} value={c.nombre}/>)}</datalist>
              </div>
              <div>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>DESTINO *</label>
                <input value={form.destino||""} onChange={e=>setForm(p=>({...p,destino:e.target.value}))} placeholder="Ej: Rotterdam" style={IST}/>
              </div>
              <div>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>EMAIL CLIENTE</label>
                <input type="email" value={form.emailCliente||""} onChange={e=>setForm(p=>({...p,emailCliente:e.target.value}))} placeholder="email@cliente.com" style={IST}/>
              </div>
            </div>

            {/* ── Sección: Productos del embarque ── */}
            <div style={{marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                <div>
                  <div style={{fontSize:10,color:"var(--txt3)",letterSpacing:2,fontWeight:700}}>PRODUCTOS DEL EMBARQUE</div>
                  <div style={{fontSize:9,color:"var(--txt3)",marginTop:2}}>Cada línea puede vincularse a un contrato diferente</div>
                </div>
                {(()=>{
                  const totalKg=(form.productosEmbarque||[]).reduce((a,l)=>a+(parseFloat(l.cantidadKg)||0),0);
                  return totalKg>0&&<div style={{fontSize:12,color:"#0EA5E9",fontWeight:800}}>TOTAL: {totalKg.toLocaleString()} kg</div>;
                })()}
              </div>
              {(form.productosEmbarque||[]).map((line,idx)=>(
                <ProductLineRow
                  key={line.id}
                  line={line}
                  idx={idx}
                  total={(form.productosEmbarque||[]).length}
                  contracts={contracts}
                  shipments={shipments}
                  editingId={editingId}
                  onUpdate={newLine=>updateLine(idx,newLine)}
                  onRemove={()=>removeLine(idx)}
                  clienteProductos={(clients.find(c=>c.nombre===form.cliente)||{}).productos||[]}
                  activeCo={activeCo}
                />
              ))}
              <button onClick={addLine} style={{fontSize:10,color:"#3B82F6",background:"rgba(59,130,246,0.08)",border:"1px dashed rgba(59,130,246,0.4)",borderRadius:7,padding:"7px 16px",width:"100%",fontFamily:"inherit",fontWeight:700,marginTop:2}}>+ AGREGAR LÍNEA DE PRODUCTO</button>
            </div>

            {contratoError&&<div style={{marginBottom:12,padding:"9px 12px",borderRadius:7,fontSize:11,background:"rgba(239,68,68,0.1)",color:"#EF4444",border:"1px solid rgba(239,68,68,0.3)"}}>⚠ {contratoError}</div>}

            {/* ── Resto de campos ── */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
              {[
                {label:"Contenedores",key:"volumen",type:"number"},
                {label:"Buque",key:"buque"},
                {label:"Fecha Salida",key:"fechaSalida",type:"date"},{label:"Fecha ETA",key:"fechaEstimada",type:"date"},
                {label:"Factura N°",key:"facturaNum"},
              ].map(f=>(
                <div key={f.key}>
                  <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>{f.label.toUpperCase()}</label>
                  <input type={f.type||"text"} value={form[f.key]||""} onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))} style={IST}/>
                </div>
              ))}
              {/* ── Reserva N° + botón Autocompletar HLAG ── */}
              <div style={{gridColumn:"1/-1"}}>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>RESERVA N°</label>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <input type="text" value={form.bl||""} onChange={e=>setForm(p=>({...p,bl:e.target.value}))} style={{...IST,flex:1}} placeholder="Ej: 18873862"/>
                  {form.naviera==="Hapag-Lloyd"&&form.bl?.trim()&&(
                    <HlagAutofillBtn
                      booking={form.bl}
                      destino={form.destino}
                      onAutofill={({buque,fechaSalida,fechaEstimada})=>
                        setForm(p=>({...p,...(buque&&{buque}),...(fechaSalida&&{fechaSalida}),...(fechaEstimada&&{fechaEstimada})}))
                      }
                    />
                  )}
                </div>
              </div>
              <div>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>NAVIERA</label>
                <select value={form.naviera} onChange={e=>setForm(p=>({...p,naviera:e.target.value}))} style={IST}>
                  {NAVIERAS.map(o=><option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>ESTADO DE DOCS</label>
                <select value={form.estadoDocs||"Pendiente"} onChange={e=>setForm(p=>({...p,estadoDocs:e.target.value}))} style={IST}>
                  {["Pendiente","Falta BL","Coordinar Retiro","Enviado"].map(o=><option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>CONDICIÓN DE PAGO</label>
                <select value={form.vencimientoType||"100% CAD"} onChange={e=>setForm(p=>({...p,vencimientoType:e.target.value}))} style={IST}>
                  {VENC_OPT.map(o=><option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            </div>
            {form.fechaEstimada&&form.vencimientoType&&(
              <div style={{marginTop:12,padding:"8px 12px",borderRadius:7,background:"rgba(59,130,246,0.08)",border:"1px solid rgba(59,130,246,0.2)",fontSize:10,color:"#3B82F6"}}>
                📅 Fecha de vencimiento calculada: <strong>{fmtDate(calcVencFecha(form.fechaEstimada,form.vencimientoType))}</strong>
              </div>
            )}
            <div style={{marginTop:14}}>
              <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>NOTAS</label>
              <textarea value={form.notas||""} onChange={e=>setForm(p=>({...p,notas:e.target.value}))} rows={2} style={{...IST,resize:"vertical"}}/>
            </div>
            <div style={{display:"flex",gap:10,marginTop:20,justifyContent:"flex-end"}}>
              <button onClick={()=>setShowForm(false)} style={{padding:"9px 20px",borderRadius:8,fontSize:12,fontFamily:"inherit",color:"var(--txt3)",background:"transparent",border:"1px solid var(--bdr)"}}>CANCELAR</button>
              <button onClick={saveForm} style={{padding:"9px 20px",borderRadius:8,fontSize:12,fontFamily:"inherit",background:"linear-gradient(135deg,#0EA5E9,#0369A1)",color:"#fff",fontWeight:700}}>GUARDAR</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Nuevo Contrato ── */}
      {showContractForm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(3,6,12,0.88)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}}>
          <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:16,width:700,maxHeight:"93vh",overflowY:"auto",padding:28,animation:"fadeUp 0.22s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div>
                <div style={{fontFamily:"'Daytona Condensed','Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:"var(--hdg)"}}>{editingContractId?"EDITAR CONTRATO":"NUEVO CONTRATO"}</div>
                <div style={{fontSize:9,color:"var(--txt3)",letterSpacing:2}}>{editingContractId||"REGISTRAR CONTRATO COMERCIAL"}</div>
              </div>
              <button onClick={()=>setShowContractForm(false)} style={{color:"var(--txt3)",fontSize:20}}>✕</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
              {[
                {label:"N° de Contrato *",key:"numero",ph:"Ej: CONT-2026-001"},
                {label:"Lote",key:"lote",ph:"Ej: LOTE-A-2026"},
                {label:"Fecha Contrato",key:"fechaContrato",type:"date"},
                {label:"Puerto Destino",key:"puertoDestino",ph:"Ej: Rotterdam"},
                {label:"Destino Final",key:"destinoFinal",ph:"Ej: Países Bajos"},
              ].map(f=>(
                <div key={f.key}>
                  <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>{f.label.toUpperCase()}</label>
                  <input type={f.type||"text"} value={contractForm[f.key]||""} onChange={e=>setContractForm(p=>({...p,[f.key]:e.target.value}))} placeholder={f.ph||""} style={IST}/>
                </div>
              ))}
              <div>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>CLIENTE *</label>
                <input list="cont-cli-list" value={contractForm.cliente||""} onChange={e=>setContractForm(p=>({...p,cliente:e.target.value}))} placeholder="Escribir o elegir cliente..." style={IST}/>
                <datalist id="cont-cli-list">{clients.map(c=><option key={c.id} value={c.nombre}/>)}</datalist>
              </div>
              <div>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>INCOTERM</label>
                <select value={contractForm.incoterm||"FOB"} onChange={e=>setContractForm(p=>({...p,incoterm:e.target.value}))} style={IST}>
                  {INCOTERMS.map(o=><option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            </div>

            {/* Productos del contrato */}
            <div style={{marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{fontSize:10,color:"var(--txt3)",letterSpacing:2,fontWeight:700}}>PRODUCTOS DEL CONTRATO</div>
                <button onClick={()=>setContractForm(p=>({...p,productos:[...(p.productos||[]),{id:`p${Date.now()}`,nombre:"",cantidadKg:"",precioUsdTon:"",entregas:[{id:`e${Date.now()}`,cantidadKg:"",fecha:""}]}]}))} style={{fontSize:9,color:"#10B981",background:"rgba(16,185,129,0.08)",border:"1px solid rgba(16,185,129,0.25)",borderRadius:5,padding:"4px 10px",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>+ Agregar producto</button>
              </div>
              {(contractForm.productos||[]).map((prod,pi)=>(
                <div key={prod.id} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:10,padding:14,marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                    <div style={{fontSize:10,color:"#10B981",fontWeight:700}}>Producto {pi+1}</div>
                    {(contractForm.productos||[]).length>1&&<button onClick={()=>setContractForm(p=>({...p,productos:p.productos.filter((_,i)=>i!==pi)}))} style={{color:"#EF4444",background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:5,padding:"2px 8px",cursor:"pointer"}}>✕</button>}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr",gap:10,marginBottom:10}}>
                    <div>
                      <label style={{fontSize:7,color:"var(--txt3)",letterSpacing:1.5,display:"block",marginBottom:3}}>NOMBRE *</label>
                      <input value={prod.nombre} onChange={e=>setContractForm(p=>({...p,productos:p.productos.map((x,i)=>i===pi?{...x,nombre:e.target.value}:x)}))} placeholder="Ej: Texturizado de Soja" style={IST}/>
                    </div>
                    <div>
                      <label style={{fontSize:7,color:"var(--txt3)",letterSpacing:1.5,display:"block",marginBottom:3}}>CANTIDAD (KG) *</label>
                      <input type="number" value={prod.cantidadKg} onChange={e=>setContractForm(p=>({...p,productos:p.productos.map((x,i)=>i===pi?{...x,cantidadKg:e.target.value}:x)}))} placeholder="Ej: 50000" style={IST}/>
                    </div>
                    <div>
                      <label style={{fontSize:7,color:"var(--txt3)",letterSpacing:1.5,display:"block",marginBottom:3}}>PRECIO USD/TON</label>
                      <input type="number" value={prod.precioUsdTon||""} onChange={e=>setContractForm(p=>({...p,productos:p.productos.map((x,i)=>i===pi?{...x,precioUsdTon:e.target.value}:x)}))} placeholder="Ej: 450" style={IST}/>
                    </div>
                  </div>
                  <div style={{borderTop:"1px solid var(--bdr)",paddingTop:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
                      <div style={{fontSize:8,color:"var(--txt3)",letterSpacing:1.5}}>ENTREGAS</div>
                      <button onClick={()=>setContractForm(p=>({...p,productos:p.productos.map((x,i)=>i===pi?{...x,entregas:[...(x.entregas||[]),{id:`e${Date.now()}`,cantidadKg:"",fecha:""}]}:x)}))} style={{fontSize:9,color:"#3B82F6",background:"rgba(59,130,246,0.08)",border:"1px solid rgba(59,130,246,0.25)",borderRadius:5,padding:"3px 8px",cursor:"pointer",fontFamily:"inherit"}}>+ Agregar entrega</button>
                    </div>
                    {(prod.entregas||[]).map((ent,ei)=>(
                      <div key={ent.id} style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:8,marginBottom:7,alignItems:"end"}}>
                        <div>
                          <label style={{fontSize:7,color:"var(--txt3)",letterSpacing:1.5,display:"block",marginBottom:3}}>ENTREGA {ei+1} — KG</label>
                          <input type="number" value={ent.cantidadKg} onChange={e=>setContractForm(p=>({...p,productos:p.productos.map((x,i)=>i===pi?{...x,entregas:x.entregas.map((en,j)=>j===ei?{...en,cantidadKg:e.target.value}:en)}:x)}))} placeholder="Ej: 50000" style={IST}/>
                        </div>
                        <div>
                          <label style={{fontSize:7,color:"var(--txt3)",letterSpacing:1.5,display:"block",marginBottom:3}}>FECHA</label>
                          <input type="date" value={ent.fecha} onChange={e=>setContractForm(p=>({...p,productos:p.productos.map((x,i)=>i===pi?{...x,entregas:x.entregas.map((en,j)=>j===ei?{...en,fecha:e.target.value}:en)}:x)}))} style={IST}/>
                        </div>
                        {(prod.entregas||[]).length>1&&<button onClick={()=>setContractForm(p=>({...p,productos:p.productos.map((x,i)=>i===pi?{...x,entregas:x.entregas.filter((_,j)=>j!==ei)}:x)}))} style={{color:"#EF4444",background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:5,padding:"5px 8px",cursor:"pointer",marginBottom:1}}>✕</button>}
                      </div>
                    ))}
                    {(()=>{const sumEnt=(prod.entregas||[]).reduce((a,e)=>a+(parseFloat(e.cantidadKg)||0),0);const tot=parseFloat(prod.cantidadKg)||0;if(tot>0&&sumEnt>0){const diff=tot-sumEnt;return <div style={{fontSize:9,marginTop:4,color:diff===0?"#10B981":diff>0?"#F59E0B":"#EF4444",fontWeight:700}}>Suma entregas: {sumEnt.toLocaleString()} kg {diff===0?"✓ OK":diff>0?`(faltan ${diff.toLocaleString()} kg)`:`(excede por ${Math.abs(diff).toLocaleString()} kg)`}</div>;}return null;})()}
                  </div>
                </div>
              ))}
            </div>

            <div style={{marginTop:8}}>
              <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>NOTAS</label>
              <textarea value={contractForm.notas||""} onChange={e=>setContractForm(p=>({...p,notas:e.target.value}))} rows={2} style={{...IST,resize:"vertical"}}/>
            </div>
            <div style={{display:"flex",gap:10,marginTop:20,justifyContent:"flex-end"}}>
              <button onClick={()=>setShowContractForm(false)} style={{padding:"9px 20px",borderRadius:8,fontSize:12,fontFamily:"inherit",color:"var(--txt3)",background:"transparent",border:"1px solid var(--bdr)"}}>CANCELAR</button>
              <button onClick={saveContract} style={{padding:"9px 20px",borderRadius:8,fontSize:12,fontFamily:"inherit",background:"linear-gradient(135deg,#10B981,#059669)",color:"#fff",fontWeight:700}}>GUARDAR CONTRATO</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Agregar Empresa ── */}
      {showAddCo&&(
        <div style={{position:"fixed",inset:0,background:"rgba(3,6,12,0.88)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}}>
          <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:14,width:480,padding:28,animation:"fadeUp 0.22s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div><div style={{fontFamily:"'Daytona Condensed','Barlow Condensed',sans-serif",fontWeight:800,fontSize:17,color:"var(--hdg)"}}>NUEVA EMPRESA</div><div style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,marginTop:2}}>REGISTRAR EMPRESA EN EL SISTEMA</div></div>
              <button onClick={()=>setShowAddCo(false)} style={{color:"var(--txt3)",fontSize:18}}>✕</button>
            </div>
            {[
              {label:"Nombre de la Empresa *",key:"name",ph:"Ej: Agroexport S.A."},
              {label:"Dirección",key:"direccion",ph:"Ej: Av. Corrientes 1234, CABA"},
              {label:"CUIT",key:"cuit",ph:"Ej: 30-12345678-9"},
              {label:"Email",key:"email",ph:"contacto@empresa.com",type:"email"},
              {label:"Sitio Web",key:"web",ph:"www.empresa.com.ar"},
            ].map(f=>(
              <div key={f.key} style={{marginBottom:13}}>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:5}}>{f.label.toUpperCase()}</label>
                <input autoFocus={f.key==="name"} type={f.type||"text"} value={newCoForm[f.key]||""} onChange={e=>setNewCoForm(p=>({...p,[f.key]:e.target.value}))} onKeyDown={e=>e.key==="Enter"&&f.key==="email"&&addCompany()} placeholder={f.ph} style={IST}/>
              </div>
            ))}
            <div style={{display:"flex",gap:10,marginTop:18,justifyContent:"flex-end"}}>
              <button onClick={()=>setShowAddCo(false)} style={{padding:"9px 18px",borderRadius:7,fontSize:12,fontFamily:"inherit",color:"var(--txt3)",background:"transparent",border:"1px solid var(--bdr)"}}>CANCELAR</button>
              <button onClick={addCompany} style={{padding:"9px 18px",borderRadius:7,fontSize:12,fontFamily:"inherit",background:"linear-gradient(135deg,#0EA5E9,#0369A1)",color:"#fff",fontWeight:700}}>CREAR EMPRESA</button>
            </div>
          </div>
        </div>
      )}

      {showExport&&<ExportModal shipments={shipments} contracts={contracts} clients={clients} onClose={()=>setShowExport(false)} currentTab={tab}/>}

      {showProformaForm&&<ProformaForm pf={proformaForm} setPf={setProformaForm} contracts={contracts} clients={clients} bankAccounts={bankAccounts} onSave={saveProforma} onClose={()=>setShowProformaForm(false)} onShowBanks={()=>setShowBankModal(true)} editingId={editingPfId} company={companies.find(c=>c.id===activeCo)||{}}/>}
      {showBankModal&&<BankAccountsModal bankAccounts={bankAccounts} onSave={saveBankAccount} onDelete={deleteBankAccount} onClose={()=>setShowBankModal(false)}/>}

      {/* ── Modal Quick New Client ── */}
      {quickNewClient&&(
        <div style={{position:"fixed",inset:0,background:"rgba(3,6,12,0.92)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}}>
          <div style={{background:"var(--bg2)",border:"1px solid rgba(16,185,129,0.3)",borderRadius:16,width:440,padding:28,animation:"fadeUp 0.22s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div style={{fontFamily:"'Daytona Condensed','Barlow Condensed',sans-serif",fontWeight:800,fontSize:18,color:"var(--hdg)"}}>NUEVO CLIENTE</div>
              <button onClick={()=>setQuickNewClient(false)} style={{background:"none",border:"none",color:"var(--txt3)",fontSize:20,cursor:"pointer"}}>✕</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
              <div style={{gridColumn:"span 2"}}>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:4}}>NOMBRE / RAZÓN SOCIAL *</label>
                <input value={newClientForm.nombre} onChange={e=>setNewClientForm(p=>({...p,nombre:e.target.value}))} placeholder="Nombre del cliente" style={IST}/>
              </div>
              <div>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:4}}>EMAIL</label>
                <input value={newClientForm.email} onChange={e=>setNewClientForm(p=>({...p,email:e.target.value}))} placeholder="email@cliente.com" style={IST}/>
              </div>
              <div>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:4}}>TELÉFONO</label>
                <input value={newClientForm.telefono} onChange={e=>setNewClientForm(p=>({...p,telefono:e.target.value}))} placeholder="+1 555 000000" style={IST}/>
              </div>
              <div style={{gridColumn:"span 2"}}>
                <label style={{fontSize:9,color:"var(--txt3)",letterSpacing:2,display:"block",marginBottom:4}}>DIRECCIÓN</label>
                <input value={newClientForm.direccion} onChange={e=>setNewClientForm(p=>({...p,direccion:e.target.value}))} placeholder="Dirección completa" style={IST}/>
              </div>
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
              <button onClick={()=>setQuickNewClient(false)} style={{padding:"9px 20px",borderRadius:8,fontSize:12,fontFamily:"inherit",color:"var(--txt3)",background:"transparent",border:"1px solid var(--bdr)",cursor:"pointer"}}>CANCELAR</button>
              <button onClick={()=>{
                if(!newClientForm.nombre.trim()) return;
                const newC={...newClientForm,id:`cli-${Date.now()}`};
                setClients(p=>[...p,newC]);
                sbUpsert("clients",clientToDb(newC,activeCo));
                setForm(p=>({...p,cliente:newC.nombre,emailCliente:newC.email||p.emailCliente}));
                setQuickNewClient(false);
              }} style={{padding:"9px 22px",borderRadius:8,fontSize:12,fontFamily:"inherit",fontWeight:700,background:"linear-gradient(135deg,#10B981,#059669)",color:"#fff",cursor:"pointer",border:"none"}}>✓ GUARDAR CLIENTE</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal Shipment Notice ── */}
      {noticeData&&(
        <div style={{position:"fixed",inset:0,background:"rgba(3,6,12,0.88)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)"}}>
          <div style={{background:"var(--bg2)",border:"1px solid rgba(16,185,129,0.3)",borderRadius:16,width:460,padding:30,animation:"fadeUp 0.22s ease",boxShadow:"0 0 40px rgba(16,185,129,0.1)"}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:18}}>
              <div style={{width:40,height:40,borderRadius:10,background:"rgba(16,185,129,0.15)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20}}>✉</div>
              <div>
                <div style={{fontFamily:"'Daytona Condensed','Barlow Condensed',sans-serif",fontWeight:800,fontSize:17,color:"var(--hdg)"}}>SHIPMENT NOTICE</div>
                <div style={{fontSize:10,color:"var(--txt3)",letterSpacing:1,marginTop:2}}>AVISO AL CLIENTE</div>
              </div>
            </div>
            <div style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:10,padding:14,marginBottom:18,fontSize:11,color:"var(--txt2)",lineHeight:1.7}}>
              <div><span style={{color:"var(--txt3)",fontSize:9,letterSpacing:1}}>PARA: </span><span style={{color:"#0EA5E9",fontWeight:700}}>{noticeData.shipment.emailCliente}</span></div>
              <div><span style={{color:"var(--txt3)",fontSize:9,letterSpacing:1}}>ASUNTO: </span><span style={{color:"var(--txt)"}}>Shipment Notice</span></div>
              <div style={{marginTop:8,borderTop:"1px solid var(--bdr)",paddingTop:8}}>
                <div><span style={{color:"var(--txt3)"}}>Proforma:</span> {noticeData.shipment.proforma||"—"}</div>
                <div><span style={{color:"var(--txt3)"}}>Cliente:</span> {noticeData.shipment.cliente}</div>
                <div><span style={{color:"var(--txt3)"}}>Naviera:</span> {noticeData.shipment.naviera||"—"}</div>
                <div><span style={{color:"var(--txt3)"}}>Salida:</span> {noticeData.shipment.fechaSalida||"—"} → <span style={{color:"var(--txt3)"}}>ETA:</span> {noticeData.shipment.fechaEstimada||"—"}</div>
              </div>
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
              <button onClick={()=>setNoticeData(null)} style={{padding:"9px 20px",borderRadius:8,fontSize:12,fontFamily:"inherit",color:"var(--txt3)",background:"transparent",border:"1px solid var(--bdr)"}}>OMITIR</button>
              <button onClick={()=>{emailShipment(noticeData.shipment,noticeData.senderEmail,activeCo);setNoticeData(null);}} style={{padding:"9px 22px",borderRadius:8,fontSize:12,fontFamily:"inherit",fontWeight:700,background:"linear-gradient(135deg,#10B981,#059669)",color:"#fff",display:"flex",alignItems:"center",gap:8}}>✉ ABRIR EN OUTLOOK</button>
            </div>
          </div>
        </div>
      )}

      {maerskModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setMaerskModal(null)}>
          <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:14,padding:24,maxWidth:560,width:"90%",maxHeight:"80vh",overflow:"auto"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontWeight:800,fontSize:15,color:"var(--hdg)"}}>🚢 MAERSK TRACKING</div>
              <button onClick={()=>setMaerskModal(null)} style={{background:"none",border:"none",color:"var(--txt3)",fontSize:18,cursor:"pointer"}}>✕</button>
            </div>
            <div style={{fontSize:11,color:"var(--txt3)",marginBottom:12}}>Booking: <b style={{color:"var(--txt)"}}>{maerskModal.booking}</b></div>
            {maerskModal.loading&&<div style={{textAlign:"center",padding:32,color:"var(--txt3)"}}>⏳ Consultando API de Maersk...</div>}
            {maerskModal.error&&<div style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:8,padding:12,color:"#EF4444",fontSize:12}}>{maerskModal.error}</div>}
            {maerskModal.events&&maerskModal.events.length===0&&<div style={{textAlign:"center",padding:24,color:"var(--txt3)",fontSize:12}}>No se encontraron eventos para este booking.</div>}
            {maerskModal.events&&maerskModal.events.length>0&&(
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {maerskModal.events.map((ev,i)=>(
                  <div key={i} style={{background:"var(--bg3)",borderRadius:8,padding:"10px 14px",borderLeft:"3px solid #0369A1"}}>
                    <div style={{fontSize:11,fontWeight:700,color:"var(--txt)",marginBottom:2}}>{ev.eventType||ev.eventClassifierCode||"Evento"}</div>
                    <div style={{fontSize:10,color:"var(--txt2)"}}>{ev.description||ev.eventDescription||""}</div>
                    <div style={{fontSize:9,color:"var(--txt3)",marginTop:3}}>{ev.eventDateTime||ev.eventCreatedDateTime||""}</div>
                    {ev.transportCall?.location?.locationName&&<div style={{fontSize:9,color:"#0EA5E9",marginTop:2}}>📍 {ev.transportCall.location.locationName}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
