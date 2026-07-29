import "./_testenv.js";
import { buildBot } from "../src/bot/bot.js";
import { createWallet } from "../src/wallet/walletService.js";
import { store } from "../src/db/store.js";
const bot = buildBot();
bot.botInfo = { id:1, is_bot:true, first_name:"T", username:"MezoAgentBot", can_join_groups:true, can_read_all_group_messages:false, supports_inline_queries:false, can_connect_to_business:false, has_main_web_app:false } as any;
const cap: {method:string,payload:any}[] = [];
bot.api.config.use(async (_p,m,pl)=>{ cap.push({method:m,payload:pl}); return { ok:true, result: m==="sendMessage"?{message_id:cap.length,date:0,chat:{id:7,type:"private"}}:true } as any; });
await bot.init();
let fail=0; const ok=(n:string,c:boolean)=>{console.log(`  ${c?"✓":"✗ FAIL"} ${n}`); if(!c)fail++;};
const msg=(uid:number,id:number,text:string)=>({update_id:id,message:{message_id:id,date:0,chat:{id:uid,type:"private"},from:{id:uid,is_bot:false,first_name:"U"},text,entities:[{type:"bot_command",offset:0,length:(text.split(" ")[0]??text).length}]}}) as any;
const tap=(uid:number,id:number,data:string)=>({update_id:id,callback_query:{id:`c${id}`,from:{id:uid,is_bot:false,first_name:"U"},chat_instance:"ci",message:{message_id:id,date:0,chat:{id:uid,type:"private"},from:bot.botInfo,text:"x"},data}}) as any;

// Referral deep-link: user 200 starts via ?start=100
await createWallet(100); // referrer exists
cap.length=0;
await bot.handleUpdate(msg(200,1,"/start 100"));
ok("referred /start shows referral note", /Referred by a friend/i.test(cap.at(-1)?.payload?.text??""));
await createWallet(200);
const rec = store.getUser(200)!;
// simulate the create-callback attribution path
await bot.handleUpdate(tap(200,2,"wallet:create"));
// /referral for referrer 100 counts >=0 and shows link
cap.length=0; await bot.handleUpdate(msg(100,3,"/referral"));
ok("/referral shows a t.me link", /t\.me\/MezoAgentBot\?start=100/.test(cap.at(-1)?.payload?.text??""));
// menu refresh callback
cap.length=0; await bot.handleUpdate(tap(100,4,"menu:refresh"));
ok("menu:refresh renders a home card", cap.some(c=>/Mezo Agent/.test(c.payload?.text??"")));
// guide button
cap.length=0; await bot.handleUpdate(tap(100,5,"menu:guide:swap"));
ok("menu:guide:swap shows swap guidance", /swap 100 MUSD/.test(cap.at(-1)?.payload?.text??""));
console.log(fail===0?"\nAll menu/referral checks passed. ✅":`\n${fail} FAILURE(S) ✗`);
process.exit(fail===0?0:1);
