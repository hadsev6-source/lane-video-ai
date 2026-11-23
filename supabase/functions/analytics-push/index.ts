import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";
const OWNER_ID = "dce2d514-964d-49be-b83d-45e6721b49a7";
const labels: Record<string,string> = {
 page_view:"Ново посещение", registration:"Нова регистрация", login:"Нов вход",
 generation_started:"Започна генерация", generation_completed:"Генерацията е завършена",
 generation_failed:"Грешка при генерация", payment_received:"Получено плащане"
};
const allowed = new Set(Object.keys(labels));
Deno.serve(async req => {
 if(req.method!=="POST") return new Response("Method not allowed",{status:405});
 try {
  const expected=Deno.env.get("PUSH_EVENT_SECRET")||"", supplied=req.headers.get("x-push-event-secret")||"";
  if(!expected || supplied.length!==expected.length) return Response.json({error:"Unauthorized"},{status:401});
  let diff=0; for(let i=0;i<expected.length;i++) diff|=expected.charCodeAt(i)^supplied.charCodeAt(i);
  if(diff!==0) return Response.json({error:"Unauthorized"},{status:401});
  const url=Deno.env.get("SUPABASE_URL"), service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const pub=Deno.env.get("VAPID_PUBLIC_KEY"), priv=Deno.env.get("VAPID_PRIVATE_KEY"), subject=Deno.env.get("VAPID_SUBJECT");
  if(!url||!service||!pub||!priv||!subject) return Response.json({error:"Push service is not fully configured"},{status:500});
  const body=await req.json(), event=String(body.event_name||"");
  if(!allowed.has(event)) return Response.json({error:"Unsupported event"},{status:400});
  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:subs,error}=await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth_key").eq("owner_id",OWNER_ID);
  if(error) throw error;
  if(!subs?.length) return Response.json({success:true,sent:0,reason:"no_subscriptions"});
  webpush.setVapidDetails(subject,pub,priv);
  const detail=String(body.detail||"").slice(0,140);
  const payload=JSON.stringify({title:"LANE AI STUDIO",body:detail?labels[event]+" — "+detail:labels[event],tag:"lane-owner-"+event+"-"+String(body.event_id||Date.now()).slice(0,80),url:"/admin"});
  let sent=0,removed=0;
  for(const row of subs) try {
   await webpush.sendNotification({endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth_key}},payload); sent++;
  } catch(e) {
   const code=Number(e?.statusCode||0);
   if(code===404||code===410){await admin.from("push_subscriptions").delete().eq("id",row.id);removed++;}
   else console.error("Push delivery failed",code||"send_error");
  }
  return Response.json({success:sent>0,sent,removed});
 } catch(e){console.error("analytics-push error",e);return Response.json({error:"Push dispatch failed"},{status:500});}
});
