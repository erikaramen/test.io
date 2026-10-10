const express=require('express'),{Pool}=require('pg'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),crypto=require('crypto'),
 path=require('path'),fs=require('fs'),rateLimit=require('express-rate-limit');
const SECRET=process.env.JWT_SECRET;
if(!SECRET||SECRET.length<24){console.error('Set JWT_SECRET (min 24 karakter)');process.exit(1)}
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const q=(t,p)=>pool.query(t,p);
const MIDTRANS=!!process.env.MIDTRANS_SERVER_KEY,DEMO=process.env.PAYMENT_MODE==='demo';
const PAY=['Saldo D Coffee','QRIS','GoPay','OVO','ShopeePay','Dana','Kartu Kredit/Debit'];
const TOPUP=[[50000,3000],[100000,10000],[200000,25000]];
const SZ=[0,3000,6000],MK=[0,8000,7000],ICE=['Tanpa','Sedikit','Normal','Ekstra'],SLOTS=['Sekarang','15 mnt','30 mnt','1 jam'];
const SEED=[[1,'Espresso',18000,'☕','Kopi',false],[2,'Americano',22000,'🧊','Kopi',false],[3,'Caffe Latte',28000,'🥛','Kopi',false],
[4,'Cappuccino',28000,'☕','Kopi',false],[5,'Kopi Susu Gula Aren',25000,'🍯','Kopi',false],[6,'Mocha',32000,'🍫','Kopi',false],
[7,'Matcha Latte',30000,'🍵','Non-Kopi',false],[8,'Es Teh Lemon',18000,'🍋','Non-Kopi',false],[9,'Croissant',20000,'🥐','Makanan',true],[10,'Roti Bakar Coklat',22000,'🍞','Makanan',true]];
const app=express();app.set('trust proxy',1);app.use(express.json({limit:'100kb'}));
const err=(s,m)=>Object.assign(new Error(m),{status:s});
const h=f=>(req,res)=>f(req,res).catch(e=>{if(!e.status)console.error(e);res.status(e.status||500).json({error:e.status?e.message:'Terjadi kesalahan server'})});
const sign=id=>jwt.sign({id},SECRET,{expiresIn:'30d'});
const nowJ=()=>new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Jakarta'}));
const hh=()=>{const x=nowJ().getHours();return x>=14&&x<16};
async function tx(fn){const c=await pool.connect();try{await c.query('begin');const r=await fn(c);await c.query('commit');return r}
 catch(e){await c.query('rollback').catch(()=>{});throw e}finally{c.release()}}
const auth=role=>async(req,res,next)=>{try{const p=jwt.verify((req.headers.authorization||'').slice(7),SECRET);
 const r=await q("select *,to_char(bday,'YYYY-MM-DD') as bday_s from users where id=$1",[p.id]);const u=r.rows[0];if(!u)throw 0;
 if(role&&u.role!==role&&u.role!=='admin')return res.status(403).json({error:'Akses ditolak'});req.u=u;next()}
 catch(e){res.status(401).json({error:'Silakan login'})}};
async function markPaid(c,oid){const r=await c.query("update orders set paid=true,status='baru' where id=$1 and not paid returning user_id,earn",[oid]);
 if(r.rows[0])await c.query('update users set points=points+$1 where id=$2',[r.rows[0].earn,r.rows[0].user_id])}
async function settle(ref,amt){await tx(async c=>{const p=(await c.query("select * from payments where ref=$1 and status='pending' for update",[ref])).rows[0];
 if(!p||(amt!=null&&Math.round(amt)!==p.amount))return;await c.query("update payments set status='paid' where ref=$1",[ref]);
 if(p.kind==='topup')await c.query('update users set wallet=wallet+$1 where id=$2',[p.amount+p.bonus,p.user_id]);else await markPaid(c,p.order_id)})}
async function snap(ref,amount,u){const base=process.env.MIDTRANS_PROD==='1'?'https://app.midtrans.com':'https://app.sandbox.midtrans.com';
 const r=await fetch(base+'/snap/v1/transactions',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',
 Authorization:'Basic '+Buffer.from(process.env.MIDTRANS_SERVER_KEY+':').toString('base64')},
 body:JSON.stringify({transaction_details:{order_id:ref,gross_amount:amount},customer_details:{first_name:u.name,phone:u.phone},
 callbacks:{finish:process.env.BASE_URL||'/'}})});
 const j=await r.json();if(!j.redirect_url)throw new Error('Midtrans: '+JSON.stringify(j));return j.redirect_url}

const lim=rateLimit({windowMs:15*60e3,max:40});
app.get('/healthz',(req,res)=>res.send('ok'));
app.post('/api/auth/register',lim,h(async(req,res)=>{
 const name=String(req.body.name||'').trim().slice(0,60),phone=String(req.body.phone||'').replace(/\D/g,''),pw=String(req.body.password||'');
 if(!name||!/^\d{9,15}$/.test(phone)||pw.length<6)throw err(400,'Data tidak valid (nama, no. HP, password min 6 karakter)');
 try{const r=await q('insert into users(phone,name,pass_hash) values($1,$2,$3) returning id',[phone,name,await bcrypt.hash(pw,10)]);res.json({token:sign(r.rows[0].id)})}
 catch(e){if(e.code==='23505')throw err(409,'No. HP sudah terdaftar');throw e}}));
app.post('/api/auth/login',lim,h(async(req,res)=>{
 const phone=String(req.body.phone||'').replace(/\D/g,'');const u=(await q('select * from users where phone=$1',[phone])).rows[0];
 if(!u||!(await bcrypt.compare(String(req.body.password||''),u.pass_hash)))throw err(401,'No. HP atau password salah');
 res.json({token:sign(u.id),role:u.role})}));
app.get('/api/menu',h(async(req,res)=>res.json((await q('select id,name,price,emoji,cat,food from menu where active order by id')).rows)));
app.get('/api/me',auth(),h(async(req,res)=>{const u=req.u;
 const g=(await q('select code,val,used,(claimed_by=$1) as mine from gifts where created_by=$1 or claimed_by=$1 order by created_at desc',[u.id])).rows;
 res.json({name:u.name,role:u.role,wallet:u.wallet,points:u.points,bday:u.bday_s,gifts:g,
 sub:u.sub_until&&new Date(u.sub_until)>new Date()?{n:'Paket Harian',until:new Date(u.sub_until).getTime()}:null})}));
app.put('/api/me',auth(),h(async(req,res)=>{const b=req.body.bday;if(b&&!/^\d{4}-\d{2}-\d{2}$/.test(b))throw err(400,'Tanggal tidak valid');
 await q('update users set bday=$1 where id=$2',[b||null,req.u.id]);res.json({ok:true})}));
app.get('/api/orders',auth(),h(async(req,res)=>res.json((await q('select code,items,total,slot,pay,earn,status,created_at from orders where user_id=$1 order by created_at desc limit 30',[req.u.id])).rows)));

app.post('/api/orders',auth(),h(async(req,res)=>{
 const{items,slot,pay,voucher,usePoints}=req.body||{};
 if(!Array.isArray(items)||!items.length||items.length>30)throw err(400,'Keranjang tidak valid');
 if(!PAY.includes(pay)||!SLOTS.includes(slot))throw err(400,'Metode bayar / jadwal tidak valid');
 const walletPay=pay===PAY[0];
 if(!walletPay&&!MIDTRANS&&!DEMO)throw err(503,'Metode pembayaran ini belum tersedia. Gunakan Saldo D Coffee.');
 const menu=(await q('select * from menu where active')).rows;let sub=0;const lines=[];
 for(const i of items){const m=menu.find(x=>x.id==i.id);if(!m)throw err(400,'Menu tidak tersedia');
  const qty=Math.min(Math.max(parseInt(i.q)||1,1),20),o=i.o||{};
  const sz=SZ[o.sz]!==undefined?+o.sz:1,mk=MK[o.mk]!==undefined?+o.mk:0,sh=Math.min(Math.max(parseInt(o.sh)||0,0),3);
  const sg=[0,25,50,75,100].includes(+o.sg)?+o.sg:100,ice=ICE.includes(o.ice)?o.ice:'Normal';
  const p=m.food?m.price:m.price+SZ[sz]+MK[mk]+sh*5000;sub+=p*qty;
  lines.push({id:m.id,n:m.name,q:qty,p,d:m.food?'':`${['S','M','L'][sz]}, ${['Reguler','Oat','Almond'][mk]}, gula ${sg}%, es ${ice}${sh?', +'+sh+' shot':''}`,o:m.food?{}:{sz,mk,sg,ice,sh}})}
 const out=await tx(async c=>{
  const u=(await c.query("select *,to_char(bday,'YYYY-MM-DD') as bday_s from users where id=$1 for update",[req.u.id])).rows[0];
  let d=0;if(hh())d+=sub*.15;
  const v=String(voucher||'').trim().toUpperCase();let gift=null;
  if(v==='HEMAT10')d+=sub*.1;
  else if(v==='ULTAH'){if(!u.bday_s||+u.bday_s.slice(5,7)-1!==nowJ().getMonth())throw err(400,'Voucher ULTAH hanya di bulan ulang tahun Anda');d+=sub*.25}
  else if(v){gift=(await c.query('select * from gifts where code=$1 and claimed_by=$2 and not used for update',[v,u.id])).rows[0];
   if(!gift)throw err(400,'Kode voucher tidak valid');d+=gift.val}
  if(usePoints){if(u.points<50)throw err(400,'Poin tidak cukup');d+=10000;await c.query('update users set points=points-50 where id=$1',[u.id])}
  d=Math.min(Math.round(d),sub);const total=sub-d;
  if(gift)await c.query('update gifts set used=true where code=$1',[v]);
  if(walletPay){if(u.wallet<total)throw err(400,'Saldo tidak cukup. Top-up dulu.');await c.query('update users set wallet=wallet-$1 where id=$2',[total,u.id])}
  const code='DC'+crypto.randomInt(100000,999999);
  const oid=(await c.query('insert into orders(code,user_id,items,subtotal,discount,total,slot,pay,earn) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',
   [code,u.id,JSON.stringify(lines),sub,d,total,slot,pay,Math.floor(total/1000)])).rows[0].id;
  const gw=!walletPay&&MIDTRANS&&total>0;
  if(gw)await c.query("insert into payments(ref,user_id,kind,amount,order_id) values($1,$2,'order',$3,$4)",[code,u.id,total,oid]);else await markPaid(c,oid);
  return{code,total,gw,u}});
 res.json({code:out.code,redirect_url:out.gw?await snap(out.code,out.total,out.u):undefined})}));

app.post('/api/topup',auth(),h(async(req,res)=>{const t=TOPUP[+req.body.idx];if(!t)throw err(400,'Paket tidak valid');
 if(!MIDTRANS&&!DEMO)throw err(503,'Top-up belum tersedia');
 const ref='TU'+crypto.randomBytes(5).toString('hex').toUpperCase();
 await q("insert into payments(ref,user_id,kind,amount,bonus) values($1,$2,'topup',$3,$4)",[ref,req.u.id,t[0],t[1]]);
 if(!MIDTRANS){await settle(ref);return res.json({ok:true})}
 res.json({redirect_url:await snap(ref,t[0],req.u)})}));
app.post('/api/payments/midtrans',h(async(req,res)=>{if(!MIDTRANS)throw err(404,'off');const b=req.body||{};
 const sig=crypto.createHash('sha512').update(String(b.order_id)+b.status_code+b.gross_amount+process.env.MIDTRANS_SERVER_KEY).digest('hex');
 if(sig!==b.signature_key)throw err(403,'signature');
 if(b.transaction_status==='settlement'||(b.transaction_status==='capture'&&b.fraud_status==='accept'))await settle(b.order_id,parseFloat(b.gross_amount));
 res.json({ok:true})}));
app.post('/api/subscribe',auth(),h(async(req,res)=>{
 const r=await q("update users set wallet=wallet-99000,sub_until=greatest(now(),coalesce(sub_until,now()))+interval '30 days' where id=$1 and wallet>=99000 returning id",[req.u.id]);
 if(!r.rowCount)throw err(400,'Saldo kurang (Rp99.000)');res.json({ok:true})}));
app.post('/api/gift',auth(),h(async(req,res)=>{const v=parseInt(req.body.val);if(!(v>=10000&&v<=1000000))throw err(400,'Nominal 10.000 – 1.000.000');
 await tx(async c=>{const r=await c.query('update users set wallet=wallet-$1 where id=$2 and wallet>=$1 returning id',[v,req.u.id]);if(!r.rowCount)throw err(400,'Saldo kurang');
  await c.query('insert into gifts(code,val,created_by) values($1,$2,$3)',['GIFT-'+crypto.randomBytes(3).toString('hex').toUpperCase(),v,req.u.id])});res.json({ok:true})}));
app.post('/api/gift/claim',auth(),h(async(req,res)=>{
 const r=await q('update gifts set claimed_by=$1 where code=$2 and claimed_by is null and not used returning code',[req.u.id,String(req.body.code||'').trim().toUpperCase()]);
 if(!r.rowCount)throw err(400,'Kode tidak valid / sudah diklaim');res.json({ok:true})}));

app.get('/api/staff/orders',auth('staff'),h(async(req,res)=>res.json((await q(
 "select o.id,o.code,o.items,o.total,o.slot,o.pay,o.status,o.created_at,u.name from orders o join users u on u.id=o.user_id where o.paid and o.status<>'selesai' and o.created_at>now()-interval '1 day' order by o.created_at")).rows)));
app.patch('/api/staff/orders/:id',auth('staff'),h(async(req,res)=>{const s=req.body.status;if(!['dibuat','siap','selesai'].includes(s))throw err(400,'Status tidak valid');
 await q('update orders set status=$1 where id=$2 and paid',[s,+req.params.id]);res.json({ok:true})}));

const mi=b=>{const name=String(b.name||'').trim().slice(0,80),price=parseInt(b.price);
 if(!name||!(price>=0&&price<=10000000))throw err(400,'Nama / harga tidak valid');
 return[name,price,String(b.emoji||'☕').slice(0,8),String(b.cat||'Kopi').trim().slice(0,30),!!b.food,b.active!==false]};
app.get('/api/admin/menu',auth('admin'),h(async(req,res)=>res.json((await q('select * from menu order by id')).rows)));
app.post('/api/admin/menu',auth('admin'),h(async(req,res)=>{await q('insert into menu(name,price,emoji,cat,food,active) values($1,$2,$3,$4,$5,$6)',mi(req.body));res.json({ok:true})}));
app.put('/api/admin/menu/:id',auth('admin'),h(async(req,res)=>{await q('update menu set name=$1,price=$2,emoji=$3,cat=$4,food=$5,active=$6 where id=$7',[...mi(req.body),+req.params.id]);res.json({ok:true})}));
app.get('/api/admin/stats',auth('admin'),h(async(req,res)=>{
 const days=(await q("select to_char(created_at at time zone 'Asia/Jakarta','YYYY-MM-DD') d,count(*)::int n,coalesce(sum(total),0)::int rev from orders where paid and created_at>now()-interval '7 days' group by 1 order by 1 desc")).rows;
 const top=(await q("select i->>'n' name,sum((i->>'q')::int)::int qty from orders o,jsonb_array_elements(o.items) i where o.paid and o.created_at>now()-interval '7 days' group by 1 order by 2 desc limit 5")).rows;
 const cust=(await q("select count(*)::int n from users where role='customer'")).rows[0].n;
 res.json({days,top,cust})}));
app.use(express.static(path.join(__dirname,'public'),{dotfiles:'allow'}));
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/staff',(req,res)=>res.sendFile(path.join(__dirname,'public','staff.html')));
(async()=>{
 await q(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
 if(!(await q('select 1 from menu limit 1')).rowCount){for(const m of SEED)await q('insert into menu(id,name,price,emoji,cat,food) values($1,$2,$3,$4,$5,$6)',m);
  await q("select setval(pg_get_serial_sequence('menu','id'),(select max(id) from menu))")}
 if(process.env.STAFF_PHONE&&process.env.STAFF_PASSWORD)await q("insert into users(phone,name,pass_hash,role) values($1,'Kasir',$2,'staff') on conflict(phone) do update set pass_hash=excluded.pass_hash,role='staff'",
  [process.env.STAFF_PHONE.replace(/\D/g,''),await bcrypt.hash(process.env.STAFF_PASSWORD,10)]);
 if(process.env.ADMIN_PHONE&&process.env.ADMIN_PASSWORD)await q("insert into users(phone,name,pass_hash,role) values($1,'Admin',$2,'admin') on conflict(phone) do update set pass_hash=excluded.pass_hash,role='admin'",
  [process.env.ADMIN_PHONE.replace(/\D/g,''),await bcrypt.hash(process.env.ADMIN_PASSWORD,10)]);
 app.listen(process.env.PORT||3000,()=>console.log('D Coffee server running'));
})().catch(e=>{console.error(e);process.exit(1)});
