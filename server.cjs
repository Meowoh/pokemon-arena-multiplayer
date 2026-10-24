const http=require('http'),fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto');
const {Server,Room}=require('@colyseus/core');const {WebSocketTransport}=require('@colyseus/ws-transport');
const TRAINERS=[{id:'ash',pokemon:25},{id:'rival',pokemon:133},{id:'brock',pokemon:74},{id:'misty',pokemon:120}];
const context={TRAINERS,console};vm.createContext(context);vm.runInContext(['pokemon-data.js','battle-engine.js','four-player.js'].map(f=>fs.readFileSync(path.join(__dirname,'rules',f),'utf8')).join('\n').replaceAll('for(const p of m.players.slice(1))','for(const p of m.players.filter(p=>!p.human))')+';globalThis.rules={D,BASES,FourPlayer,Combat,rollShop};',context);
const {D,FourPlayer,Combat,rollShop}=context.rules;
class Arena extends Room{
 onCreate(){this.maxClients=4;this.setPrivate(true);this.roomId=crypto.randomBytes(5).toString('hex').toUpperCase();this.uid=0;this.phase='lobby';this.seats=new Map();this.ready=new Set();this.sequence=0;this.battles=[];this.tick=0;this.frame=0;
  const own=this.player('A','ash');this.match=FourPlayer.create(own,()=>++this.uid);this.match.players.forEach(p=>{p.human=false;p.name='電腦';p.units=[{id:TRAINERS.find(t=>t.id===p.trainerId).pokemon,uid:++this.uid,star:1,pos:52}];p.gold=12;p.preparedRound=0;FourPlayer.shop(p)});
  this.onMessage('action',(c,a)=>{try{this.action(c,a)}catch(e){c.send('notice',e.message||'操作失敗')}});
  this.onMessage('snapshot',c=>this.sendState(c));this.setSimulationInterval(()=>this.step(),Number(process.env.SIM_INTERVAL_MS)||1000/30);
 }
 player(key,trainer){return{key,trainerId:trainer,gold:12,life:100,round:1,wins:0,cap:3,units:[],shop:[],history:[],results:{win:0,loss:0,draw:0},shopLocked:false,boardVersion:8,evolutionVersion:2}}
 onJoin(c,options){if(this.phase!=='lobby')throw Error('對局已開始');const index=this.match.players.findIndex(p=>!p.human);if(index<0)throw Error('房間已滿');const p=this.match.players[index],trainer=TRAINERS.find(t=>t.id===options.trainer)||TRAINERS[index];Object.assign(p,this.player(p.key,trainer.id),{human:true,connected:true,name:String(options.name||'玩家').replace(/[<>]/g,'').slice(0,16)});p.units=[{id:trainer.pokemon,uid:++this.uid,star:1,pos:52}];FourPlayer.shop(p);this.seats.set(c.sessionId,index);this.host??=c.sessionId;this.sendAll()}
 async onDrop(c){const i=this.seats.get(c.sessionId);if(i===undefined)return;this.match.players[i].connected=false;this.sendAll();try{await this.allowReconnection(c,60)}catch{}}
 onReconnect(c){const i=this.seats.get(c.sessionId);if(i!==undefined)this.match.players[i].connected=true;this.sendAll()}
 onLeave(c){const i=this.seats.get(c.sessionId);if(i===undefined)return;const p=this.match.players[i];this.seats.delete(c.sessionId);p.human=false;p.connected=false;p.name='電腦';this.ready.delete(i);if(this.host===c.sessionId)this.host=[...this.seats.keys()][0];if(this.phase==='prepare')FourPlayer.prepareAI(this.match,()=>++this.uid);this.sendAll()} action(c,a){const i=this.seats.get(c.sessionId),p=this.match.players[i];if(!p||!a||typeof a!=='object')return;const now=Date.now();if(now-(c.lastAction||0)<45)return;c.lastAction=now;
  if(a.type==='start'){if(c.sessionId!==this.host||this.phase!=='lobby')throw Error('只有房主可開始');if([...this.seats.values()].some(j=>!this.match.players[j].connected))throw Error('請等待斷線玩家重連');this.lock();this.phase='prepare';FourPlayer.prepareAI(this.match,()=>++this.uid);this.deadline=Date.now()+60000;this.sendAll();return}
  if(this.phase!=='prepare'||p.life<=0)throw Error('目前不能調整棋子');this.ready.delete(i);
  if(a.type==='ready'){this.ready.add(i)}
  else if(a.type==='buy'){if(!Number.isInteger(a.index)||a.index<0||a.index>4)return;const d=D.find(d=>d.id===p.shop[a.index]);if(!d||p.gold<d.c)throw Error('金幣不足');if(p.units.filter(u=>u.pos===null).length>=8&&p.units.filter(u=>u.id===d.id&&u.star===1).length<2)throw Error('後備席已滿');p.gold-=d.c;p.units.push({id:d.id,uid:++this.uid,star:1,pos:null});p.shop[a.index]=null;FourPlayer.merge(p)}
  else if(a.type==='refresh'){if(p.gold<2)throw Error('金幣不足');p.gold-=2;FourPlayer.shop(p)}
  else if(a.type==='level'){if(p.gold<4||p.cap>=8)throw Error('無法提升人口');p.gold-=4;p.cap++}
  else if(a.type==='lock')p.shopLocked=!p.shopLocked;
  else if(a.type==='sell'){const u=p.units.find(u=>u.uid===a.uid);if(!u)return;p.gold+=D.find(d=>d.id===u.id).c*3**(u.star-1);p.units=p.units.filter(v=>v!==u)}
  else if(a.type==='move'){const u=p.units.find(u=>u.uid===a.uid),t=a.target;if(!u||!t||!Number.isInteger(t.index))return;this.bench(p);if(t.kind==='board'){if(t.index<32||t.index>63)return;const other=p.units.find(v=>v.pos===t.index);if(other===u)return;if(u.pos===null&&!other&&p.units.filter(v=>v.pos!==null).length>=p.cap)throw Error('上陣人口已滿');if(other){other.pos=u.pos;other.benchSlot=u.benchSlot}u.pos=t.index;delete u.benchSlot}else if(t.kind==='bench'){if(t.index<0||t.index>7)return;const other=p.units.find(v=>v.pos===null&&v.benchSlot===t.index);if(other===u)return;if(other){other.pos=u.pos;other.benchSlot=u.benchSlot}u.pos=null;u.benchSlot=t.index}else return;this.bench(p)}
  else return;
  if(this.match.players.every((v,j)=>v.life<=0||!v.human||this.ready.has(j)))this.begin();this.sendAll();
 }
 bench(p){const used=new Set();for(const u of p.units){if(u.pos!==null){delete u.benchSlot;continue}if(!Number.isInteger(u.benchSlot)||used.has(u.benchSlot))u.benchSlot=Array.from({length:8},(_,i)=>i).find(i=>!used.has(i));used.add(u.benchSlot)}}
 begin(){this.phase='battle';this.ready.clear();this.tick=0;this.frame=0;this.battles=FourPlayer.makeBattles(this.match);this.events=[]}
 step(){if(this.phase==='prepare'&&Date.now()>=this.deadline)this.begin();if(this.phase!=='battle')return;this.frame++;for(const b of this.battles)if(!b.done)Combat.move(b.units,1/30);if(this.frame%21===0){this.tick++;this.events=FourPlayer.step(this.battles,this.tick).map(e=>({...e,seq:++this.sequence}));if(this.battles.every(b=>b.done)){FourPlayer.settle(this.match,this.battles,()=>++this.uid);this.phase=this.match.finished?'finished':'prepare';this.deadline=Date.now()+60000;this.battles=[]}}if(this.frame%3===0)this.sendAll()}
 sendState(c){const seat=this.seats.get(c.sessionId);if(seat===undefined)return;this.match.players.forEach(p=>this.bench(p));const players=this.match.players.map((p,i)=>({...p,shop:i===seat?p.shop:[],ready:this.ready.has(i)}));c.send('snapshot',{room:this.roomId,seat,host:c.sessionId===this.host,phase:this.phase,deadline:this.deadline||0,match:{...this.match,players},battles:this.battles,fx:this.events||[]})}
 sendAll(){for(const c of this.clients)this.sendState(c)}
}
function start(port=Number(process.env.PORT)||2567){const server=new Server({transport:new WebSocketTransport({maxPayload:16384}),express:app=>{app.get('/health',(req,res)=>res.json({ok:true,service:'pokemon-arena-multiplayer'}))}});server.define('arena',Arena);server.listen(port,'0.0.0.0');return server}if(require.main===module)start();module.exports={Arena,start};



