// Craftline application server: Node.js 24 with SQLite (local) or shared PostgreSQL (multi-host).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cluster = require('node:cluster');
const { createGzip } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');
const express = require('express');

const ROOT = __dirname;
const MAX_BODY = 2 * 1024 * 1024;

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const row of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = row.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
}
loadEnv();
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATABASE_URL = process.env.DATABASE_URL || '';
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'craftline.sqlite');
const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_DIR = path.join(ROOT, 'public');
let sqlite = null;
let pool = null;
function sqliteSchema() { return `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-20000; PRAGMA temp_store=MEMORY;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
 trade TEXT NOT NULL, experience TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
 suspended INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS posts (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, trade TEXT NOT NULL REFERENCES categories(name),
 kind TEXT NOT NULL, summary TEXT NOT NULL, body TEXT NOT NULL, image TEXT, video_url TEXT,
 author_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, initial_helpful INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS comments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS helpful_votes (
 post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(post_id,user_id)
);
CREATE TABLE IF NOT EXISTS ratings (
 post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
 created_at TEXT NOT NULL, PRIMARY KEY(post_id,user_id)
);
CREATE TABLE IF NOT EXISTS bookmarks (
 post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, PRIMARY KEY(post_id,user_id)
);
CREATE TABLE IF NOT EXISTS rate_limits (
 scope TEXT NOT NULL, ip TEXT NOT NULL, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL,
 PRIMARY KEY(scope,ip)
);`; }
const postgresSchema = `CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
 trade TEXT NOT NULL, experience TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
 suspended INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS categories (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS posts (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, trade TEXT NOT NULL REFERENCES categories(name), kind TEXT NOT NULL,
 summary TEXT NOT NULL, body TEXT NOT NULL, image TEXT, video_url TEXT, author_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, initial_helpful INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS comments (id BIGSERIAL PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS helpful_votes (post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(post_id,user_id));
CREATE TABLE IF NOT EXISTS ratings (post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5), created_at TEXT NOT NULL, PRIMARY KEY(post_id,user_id));
CREATE TABLE IF NOT EXISTS bookmarks (post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(post_id,user_id));
CREATE TABLE IF NOT EXISTS rate_limits (scope TEXT NOT NULL, ip TEXT NOT NULL, window_start BIGINT NOT NULL, attempts INTEGER NOT NULL, PRIMARY KEY(scope,ip));`;
const indexesSql = `CREATE INDEX IF NOT EXISTS idx_posts_status_created ON posts(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_trade_status_created ON posts(trade,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author_created ON posts(author_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id,id);
CREATE INDEX IF NOT EXISTS idx_ratings_post_id ON ratings(post_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_created ON bookmarks(user_id,created_at DESC);`;

function pgSql(text) { let index=0; return text.replace(/\?/g,()=>`$${++index}`); }
async function query(text, params=[]) {
 if (pool) { const result=await pool.query(pgSql(text),params); return {rows:result.rows,changes:result.rowCount||0}; }
 const stmt=sqlite.prepare(text);
 return {stmt};
}
async function get(text,...params) { const result=await query(text,params); return result.rows ? result.rows[0] : result.stmt.get(...params); }
async function all(text,...params) { const result=await query(text,params); return result.rows || result.stmt.all(...params); }
async function run(text,...params) { const result=await query(text,params); if(result.rows)return {changes:result.changes,rows:result.rows}; const info=result.stmt.run(...params);return {changes:info.changes}; }
async function dbExec(text) { if(pool) await pool.query(text); else sqlite.exec(text); }
async function initializeDatabase(createSchema) {
 if(DATABASE_URL) {
  const poolBudget=Math.max(1,Math.min(100,Number.parseInt(process.env.PG_POOL_BUDGET||'20',10)||20));
  pool=new Pool({connectionString:DATABASE_URL,max:Math.max(1,Math.floor(poolBudget/WORKERS)),ssl:process.env.PGSSLMODE==='require'?{rejectUnauthorized:process.env.PGSSL_REJECT_UNAUTHORIZED!=='false'}:undefined});
  if(createSchema){
   const client=await pool.connect();
   try{await client.query('SELECT pg_advisory_lock(5827319041)');await client.query('BEGIN');await client.query(postgresSchema);await client.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_url TEXT');await client.query(indexesSql);await client.query('COMMIT');await client.query('SELECT pg_advisory_unlock(5827319041)')}
   catch(error){try{await client.query('ROLLBACK');await client.query('SELECT pg_advisory_unlock(5827319041)')}catch{}throw error}
   finally{client.release()}
  }
  return;
 }
 fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
 sqlite=new DatabaseSync(DB_PATH);
 if(createSchema){
  sqlite.exec(sqliteSchema());
  if(!sqlite.prepare('PRAGMA table_info(posts)').all().some(column=>column.name==='video_url'))sqlite.exec('ALTER TABLE posts ADD COLUMN video_url TEXT');
  sqlite.exec(indexesSql);
 }
}

const DEFAULT_CATEGORIES = [
 ['Electrical','Wiring methods, safe diagnostics, and practical electrical learning notes.'],
 ['Plumbing','Reliable installation methods, repair sequences, and plumbing field notes.'],
 ['Welding','Workshop setups, fabrication methods, and welding practice notes.'],
 ['Mechanics','Maintenance knowledge, mechanical diagnostics, and repair procedures.'],
 ['Carpentry','Layout, installation, joinery, and finish carpentry from the field.'],
 ['HVAC','Heating, ventilation, and cooling maintenance and troubleshooting.'],
];
const seedPosts = [
 ['p101','Flaring copper tubing without ovaling the end','Plumbing','Field guide','A repeatable setup for clean flares on 1/2″ and 3/4″ copper lines, from a careful cut to the final inspection.','SET UP\nUse a sharp tubing cutter and tighten it gradually as you turn. A heavy first pass can push the tube out of round.\n\nPREPARE THE END\nReam the inside edge until the burr is gone, then lightly clean the outside. Keep the tube end square.\n\nFLARE\nSeat the tube so it projects the amount specified by your flaring tool. Center the yoke and advance the cone steadily.\n\nCHECK\nLook for an even flare with no cracks or thin spots. If it is uneven, cut it back and start again. Always follow the fitting maker’s instructions and local plumbing code.','Ravi Menon','Plumber','18 years',5,128,842,[['Anita S.','The deburring reminder is key. I also use a drop of oil on the cone.'],['Joel K.','Works well on refrigeration lines too.']]],
 ['p102','When a breaker trips after the circuit has been running','Electrical','Troubleshooting','If a breaker holds at first and trips under load, work through the circuit safely before considering replacement.','SAFETY FIRST\nOnly qualified people should open panels or test energized circuits. Isolate, verify absence of voltage, and use the correct PPE and test equipment.\n\nNARROW IT DOWN\nRecord what is connected and when the trip occurs. Check circuit load against breaker and conductor ratings. Inspect for loose terminations, damaged insulation, or a failing appliance.\n\nCONFIRM BEFORE REPLACING\nUse an appropriate clamp meter and follow your workplace procedure. Never upsize a breaker to stop nuisance trips. Identify and correct the fault, then verify the installation against local electrical code.','Meera Kulkarni','Electrician','12 years',7,96,674,[['Ben T.','Good reminder to check the load first. Thermal trips get misdiagnosed a lot.']]],
 ['p103','Three checks before welding thin mild steel','Welding','Workshop note','Thin sheet punishes a rushed setup. These checks help keep the puddle controlled and reduce burn-through.','1. CLEAN THE JOINT\nRemove oil, paint, rust, and coatings using the correct process for the material.\n\n2. CLAMP AND TACK\nUse a flat backing surface and evenly spaced tacks to limit movement.\n\n3. SET UP ON SCRAP\nStart with the machine and consumable manufacturer’s guidance, then test on matching scrap. Adjust travel speed and technique for a consistent bead. Wear required PPE and ensure ventilation.','Arjun Das','Fabricator','9 years',4,84,528,[]],
 ['p104','Why a new drive belt keeps squealing on a compressor','Mechanics','Troubleshooting','A new belt can still squeal when alignment or tension is off. This inspection order avoids overtightening and bearing damage.','Disconnect and lock out power before inspection. Check pulley alignment with a straightedge, inspect pulley grooves and bearings, then set belt tension to the equipment manual specification. Replace belts as a matched set where required. Refit guards before returning equipment to service.','Joseph D’Souza','Mechanical technician','15 years',6,67,416,[]],
 ['p105','Laying out shelf brackets on an uneven wall','Carpentry','Field guide','A story pole and one shared reference line save time when a wall is not perfectly straight.','Find and mark the intended height at both ends. Snap a level reference line, locate studs, and transfer bracket marks from a story pole. Confirm the fastener suits the wall and expected load. Check level again before loading the shelf.','Nisha Rao','Carpenter','11 years',4,52,309,[]],
 ['p106','A multimeter routine before trusting the reading','Electrical','Learning note','Meter settings, lead placement, and proving the tester matter as much as the reading itself.','Choose a meter rated for the environment and measurement. Inspect leads, select the correct function and range, and verify the instrument on a known source before and after the test. Follow safe isolation practices; never use resistance mode on an energized circuit.','Sanjay Patil','Electrical instructor','22 years',8,46,288,[]],
 ['p107','Finding airflow restrictions before replacing an HVAC filter','HVAC','Maintenance note','A practical inspection sequence to tell a loaded filter from a return-air or coil restriction.','Switch the system off before opening access panels. Check filter size, orientation, and pressure drop against equipment requirements. Inspect return grilles for blockage and review the maintenance history. If airflow remains low, follow the service manual and use the specified test procedure.','Farah Khan','HVAC technician','14 years',6,39,251,[]],
];
async function seedData() {
 for (const [name, description] of DEFAULT_CATEGORIES) await run('INSERT INTO categories(name,description) VALUES(?,?) ON CONFLICT(name) DO NOTHING',name,description);
 const userCount=Number((await get('SELECT count(*) AS n FROM users')).n);
 if(!userCount){
  const ids=new Map(),contributors=new Map();
  for(const p of seedPosts)contributors.set(p[6],{title:p[7],experience:p[8]});
  for(const [name,info] of contributors){
   const id='seed-'+crypto.createHash('sha1').update(name).digest('hex').slice(0,12),salt=crypto.randomBytes(16).toString('hex'),hash=crypto.pbkdf2Sync(crypto.randomBytes(32),salt,120000,32,'sha256').toString('hex');
   await run('INSERT INTO users(id,name,email,password_salt,password_hash,trade,experience,role,joined_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',id,name,`${id}@seed.craftline.invalid`,salt,hash,info.title,info.experience,'member','2026-09-20');ids.set(name,id);
  }
  for(const p of seedPosts){
   const [id,title,trade,kind,summary,body,author,, , ,helpful,views,comments]=p;
   const dates={p101:'24',p102:'23',p103:'21',p104:'19',p105:'17',p106:'15',p107:'12'};
   await run('INSERT INTO posts(id,title,trade,kind,summary,body,author_id,status,created_at,views,initial_helpful) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',id,title,trade,kind,summary,body,ids.get(author),'published',`2026-09-${dates[id]}`,views,helpful);
   for(const [name,text] of comments){let u=await get('SELECT id FROM users WHERE name=?',name);if(!u){const uid='comment-'+crypto.randomBytes(5).toString('hex'),salt=crypto.randomBytes(16).toString('hex'),hash=crypto.pbkdf2Sync(crypto.randomBytes(32),salt,120000,32,'sha256').toString('hex');await run('INSERT INTO users(id,name,email,password_salt,password_hash,trade,experience,role,joined_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',uid,name,`${uid}@seed.craftline.invalid`,salt,hash,'Trade learner','Student / apprentice','member','2026-09-20');u={id:uid}}await run('INSERT INTO comments(post_id,user_id,body,created_at) VALUES(?,?,?,?)',id,u.id,text,'2026-09-24')}
  }
 }
 await run("UPDATE posts SET video_url=? WHERE id='p101' AND (video_url IS NULL OR video_url='')",'https://www.youtube-nocookie.com/embed/vRGn9MjQnGY');
}

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const passwordHash = (password,salt) => crypto.pbkdf2Sync(password,salt,310000,32,'sha256');
function publicUser(u){return {id:u.id,name:u.name,email:u.email,trade:u.trade,experience:u.experience,role:u.role,suspended:Boolean(u.suspended),joined:u.joined_at}}
async function issueSession(userId,res){const token=crypto.randomBytes(32).toString('base64url'),expires=Date.now()+SESSION_TTL;await run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',hashToken(token),userId,expires);res.setHeader('Set-Cookie',`craftline_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL/1000)}${PROD?'; Secure':''}`)}
function cookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),decodeURIComponent(x.slice(i+1))]}))}
async function currentUser(req){const token=cookies(req).craftline_session;if(!token)return null;const row=await get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`,hashToken(token),Date.now());return row&&!row.suspended?row:null}
async function requireUser(req,res){const user=await currentUser(req);if(!user){sendJson(res,401,{error:'Please sign in to continue.'});return null}return user}
async function requireAdmin(req,res){const user=await requireUser(req,res);if(!user)return null;if(user.role!=='admin'){sendJson(res,403,{error:'Moderator access is required.'});return null}return user}
function sendJson(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(body)});res.end(body)}
function readBody(req){return new Promise((resolve,reject)=>{let size=0,parts=[];req.on('data',chunk=>{size+=chunk.length;if(size>MAX_BODY){reject(Object.assign(new Error('Request is too large.'),{status:413}));req.destroy();return}parts.push(chunk)});req.on('end',()=>{if(!parts.length)return resolve({});try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')))}catch{reject(Object.assign(new Error('Invalid JSON request.'),{status:400}))}});req.on('error',reject)})}
const RATE_LIMIT_WINDOW = 15 * 60_000;
async function rateLimit(req,key){const forwarded=process.env.TRUST_PROXY==='true'?String(req.headers['x-forwarded-for']||'').split(',').map(x=>x.trim()).filter(Boolean):[],ip=forwarded.at(-1)||req.socket.remoteAddress||'local',now=Date.now(),cutoff=now-RATE_LIMIT_WINDOW,row=await get(`INSERT INTO rate_limits(scope,ip,window_start,attempts) VALUES(?,?,?,1)
 ON CONFLICT(scope,ip) DO UPDATE SET window_start=CASE WHEN rate_limits.window_start<=? THEN excluded.window_start ELSE rate_limits.window_start END,
 attempts=CASE WHEN rate_limits.window_start<=? THEN 1 ELSE rate_limits.attempts+1 END RETURNING attempts`,key,ip,now,cutoff,cutoff);return Number(row.attempts)<=12}
function safeEqual(a,b){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function postShape(row,userId){return {id:row.id,title:row.title,trade:row.trade,kind:row.kind,summary:row.summary,body:row.body,image:row.image||'',videoUrl:row.video_url||'',author:row.author_name,role:row.author_trade,initials:row.initials,date:row.created_at,minutes:Math.max(2,Math.ceil(row.body.split(/\s+/).length/150)),helpful:row.helpful||0,ratingAverage:Number(row.rating_average||0),ratingCount:row.rating_count||0,commentCount:row.comment_count||0,views:row.views,comments:row.comments||[],status:row.status,saved:Boolean(row.saved)}}
const postSelect=`SELECT p.*,u.name AS author_name,(u.trade||' · '||u.experience) AS author_trade,substr(u.name,1,2) AS initials,(p.initial_helpful+(SELECT count(*) FROM helpful_votes v WHERE v.post_id=p.id)) AS helpful,coalesce((SELECT round(avg(r.score),1) FROM ratings r WHERE r.post_id=p.id),0) AS rating_average,(SELECT count(*) FROM ratings r WHERE r.post_id=p.id) AS rating_count,(SELECT count(*) FROM comments c WHERE c.post_id=p.id) AS comment_count,(SELECT count(*) FROM bookmarks b WHERE b.post_id=p.id AND b.user_id=?) AS saved FROM posts p JOIN users u ON u.id=p.author_id`;
async function getPost(id,userId,includeComments=true){const row=await get(`${postSelect} WHERE p.id=?`,userId||'',id);if(!row)return null;const shaped=postShape(row,userId);shaped.comments=includeComments?await all(`SELECT c.body AS text,u.name AS name,c.created_at AS date FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.id`,id):[];return shaped}
function validText(value,min,max){return typeof value==='string'&&value.trim().length>=min&&value.trim().length<=max}
function imageValue(value){if(!value)return '';if(typeof value!=='string'||value.length>1_600_000||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value))throw Object.assign(new Error('Choose a PNG, JPEG, or WebP image under 1.2 MB.'),{status:400});return value}
async function imageForStorage(value){if(!value)return '';const data=imageValue(value),settings=[process.env.CLOUDINARY_CLOUD_NAME,process.env.CLOUDINARY_API_KEY,process.env.CLOUDINARY_API_SECRET];if(settings.every(x=>!x))return data;if(settings.some(x=>!x))throw Object.assign(new Error('Cloud image storage needs CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.'),{status:503});const match=data.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);if(!match)return data;const timestamp=String(Math.floor(Date.now()/1000)),signature=crypto.createHash('sha1').update(`timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`).digest('hex'),form=new FormData();form.append('file',new Blob([Buffer.from(match[2],'base64')],{type:match[1]}),'field-note-image');form.append('api_key',process.env.CLOUDINARY_API_KEY);form.append('timestamp',timestamp);form.append('signature',signature);const response=await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(process.env.CLOUDINARY_CLOUD_NAME)}/image/upload`,{method:'POST',body:form});let result={};try{result=await response.json()}catch{}if(!response.ok||typeof result.secure_url!=='string'||!result.secure_url.startsWith('https://res.cloudinary.com/'))throw Object.assign(new Error('The image could not be saved to Cloudinary. Check the cloud settings and try again.'),{status:502});return result.secure_url}
function videoValue(value){if(!value)return '';if(typeof value!=='string'||value.length>300)throw Object.assign(new Error('Use a valid YouTube or Vimeo video link.'),{status:400});let u;try{u=new URL(value)}catch{throw Object.assign(new Error('Use a valid YouTube or Vimeo video link.'),{status:400})}if(!['https:','http:'].includes(u.protocol))throw Object.assign(new Error('Use a valid YouTube or Vimeo video link.'),{status:400});const host=u.hostname.toLowerCase();let id='';if(['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtu.be'].includes(host)){id=host.endsWith('youtu.be')?u.pathname.split('/').filter(Boolean)[0]||'':u.searchParams.get('v')||u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/)?.[1]||'';if(!/^[\w-]{11}$/.test(id))throw Object.assign(new Error('That YouTube link does not look valid.'),{status:400});return `https://www.youtube-nocookie.com/embed/${id}`}if(['vimeo.com','www.vimeo.com','player.vimeo.com'].includes(host)){id=u.pathname.split('/').filter(Boolean).at(-1)||'';if(!/^\d{5,12}$/.test(id))throw Object.assign(new Error('That Vimeo link does not look valid.'),{status:400});return `https://player.vimeo.com/video/${id}`}throw Object.assign(new Error('Only YouTube and Vimeo video links are supported.'),{status:400})}

async function api(req,res,url){
 const method=req.method,parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
 if(parts[1]==='health'&&method==='GET'){try{await get('SELECT 1');return sendJson(res,200,{ok:true,database:DATABASE_URL?'postgresql':'sqlite'})}catch{return sendJson(res,503,{ok:false,error:'Database unavailable.'})}}
 if(parts[1]==='bootstrap'&&method==='GET'){const user=await currentUser(req),uid=user?.id||'',rows=await all(`${postSelect} WHERE p.status='published' ORDER BY p.created_at DESC`,uid),result=rows.map(r=>{const post=postShape(r,uid);post.image='';post.comments=[];return post}),categories=await all('SELECT name,description FROM categories ORDER BY name'),saved=(await all('SELECT post_id FROM bookmarks WHERE user_id=?',uid)).map(x=>x.post_id),metricRows=await Promise.all([get('SELECT count(*) n FROM users'),get('SELECT count(*) n FROM comments'),get('SELECT count(*) n FROM ratings'),get("SELECT count(DISTINCT author_id) n FROM posts WHERE status='published'")]),kpis={published:result.length,users:Number(metricRows[0].n),comments:Number(metricRows[1].n),ratings:Number(metricRows[2].n),contributors:Number(metricRows[3].n),views:result.reduce((sum,post)=>sum+(post.views||0),0)};kpis.engagement=kpis.comments+kpis.ratings;kpis.contributionRate=kpis.users?Math.round(kpis.contributors/kpis.users*100):0;return sendJson(res,200,{user:user?publicUser(user):null,categories,posts:result,saved,kpis})}
 if(parts[1]==='register'&&method==='POST'){if(!await rateLimit(req,'register'))return sendJson(res,429,{error:'Too many attempts. Try again in 15 minutes.'});const b=await readBody(req);if(!validText(b.name,2,80)||!validText(b.email,5,254)||!/^\S+@\S+\.\S+$/.test(b.email)||!validText(b.password,12,200)||!validText(b.trade,2,50)||!validText(b.experience,2,40))return sendJson(res,400,{error:'Enter a valid name, email, trade, experience level, and password (12 characters minimum).'});const email=b.email.trim().toLowerCase();if(await get('SELECT id FROM users WHERE email=?',email))return sendJson(res,409,{error:'An account with that email already exists. Sign in instead.'});const salt=crypto.randomBytes(16).toString('hex'),id=crypto.randomUUID(),derived=passwordHash(b.password,salt);await run('INSERT INTO users(id,name,email,password_salt,password_hash,trade,experience,joined_at) VALUES(?,?,?,?,?,?,?,?)',id,b.name.trim(),email,salt,derived.toString('hex'),b.trade.trim(),b.experience.trim(),new Date().toISOString().slice(0,10));await issueSession(id,res);return sendJson(res,201,{user:publicUser(await get('SELECT * FROM users WHERE id=?',id))})}
 if(parts[1]==='login'&&method==='POST'){if(!await rateLimit(req,'login'))return sendJson(res,429,{error:'Too many attempts. Try again in 15 minutes.'});const b=await readBody(req),email=String(b.email||'').trim().toLowerCase(),u=await get('SELECT * FROM users WHERE email=?',email);if(!u){passwordHash(String(b.password||''),'00000000000000000000000000000000');return sendJson(res,401,{error:'Email or password is incorrect.'})}if(u.suspended)return sendJson(res,403,{error:'This profile is paused. Contact a platform moderator.'});if(!safeEqual(passwordHash(String(b.password||''),u.password_salt).toString('hex'),u.password_hash))return sendJson(res,401,{error:'Email or password is incorrect.'});await run('DELETE FROM sessions WHERE expires_at<?',Date.now());await issueSession(u.id,res);return sendJson(res,200,{user:publicUser(u)})}
 if(parts[1]==='logout'&&method==='POST'){const token=cookies(req).craftline_session;if(token)await run('DELETE FROM sessions WHERE token_hash=?',hashToken(token));res.setHeader('Set-Cookie',`craftline_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${PROD?'; Secure':''}`);return sendJson(res,200,{ok:true})}
 if(parts[1]==='me'&&method==='PATCH'){const u=await requireUser(req,res);if(!u)return;const b=await readBody(req);if(!validText(b.name,2,80)||!validText(b.trade,2,50)||!validText(b.experience,2,40))return sendJson(res,400,{error:'Please provide a name, trade, and experience level.'});await run('UPDATE users SET name=?,trade=?,experience=? WHERE id=?',b.name.trim(),b.trade.trim(),b.experience.trim(),u.id);return sendJson(res,200,{user:publicUser(await get('SELECT * FROM users WHERE id=?',u.id))})}
 if(parts[1]==='posts'&&parts.length===2&&method==='GET'){const u=await currentUser(req),trade=url.searchParams.get('trade'),term=(url.searchParams.get('q')||'').trim().slice(0,100),rows=await all(`${postSelect} WHERE p.status='published' AND (?='' OR p.trade=?) AND (?='' OR lower(p.title||' '||p.summary||' '||p.body) LIKE ?) ORDER BY p.created_at DESC`,u?.id||'',trade||'',trade||'',term,`%${term.toLowerCase()}%`);return sendJson(res,200,{posts:rows.map(r=>postShape(r,u?.id))})}
 if(parts[1]==='posts'&&parts.length===2&&method==='POST'){const u=await requireUser(req,res);if(!u)return;const b=await readBody(req);if(!validText(b.title,8,100)||!validText(b.summary,25,260)||!validText(b.body,80,12000)||!validText(b.kind,3,40)||b.safety!==true)return sendJson(res,400,{error:'Complete the title, summary, step-by-step guide, and safety confirmation.'});if(!await get('SELECT name FROM categories WHERE name=?',b.trade))return sendJson(res,400,{error:'Choose an active trade category.'});let image,videoUrl;try{image=imageValue(b.image);videoUrl=videoValue(b.videoUrl);image=await imageForStorage(image)}catch(e){return sendJson(res,e.status||400,{error:e.message})}const id=crypto.randomUUID(),date=new Date().toISOString().slice(0,10);await run('INSERT INTO posts(id,title,trade,kind,summary,body,image,video_url,author_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,b.title.trim(),b.trade,b.kind,b.summary.trim(),b.body.trim(),image,videoUrl,u.id,'pending',date);return sendJson(res,201,{id,status:'pending'})}
 if(parts[1]==='posts'&&parts.length===3&&method==='GET'){const u=await currentUser(req),row=await get(`${postSelect} WHERE p.id=? AND p.status='published'`,u?.id||'',parts[2]);if(!row)return sendJson(res,404,{error:'Guide not found.'});await run('UPDATE posts SET views=views+1 WHERE id=?',parts[2]);return sendJson(res,200,{post:await getPost(parts[2],u?.id)})}
 if(parts[1]==='posts'&&parts.length===4&&parts[3]==='comments'&&method==='POST'){const u=await requireUser(req,res);if(!u)return;const b=await readBody(req);if(!validText(b.text,2,500))return sendJson(res,400,{error:'Write a comment between 2 and 500 characters.'});if(!await get("SELECT id FROM posts WHERE id=? AND status='published'",parts[2]))return sendJson(res,404,{error:'Guide not found.'});await run('INSERT INTO comments(post_id,user_id,body,created_at) VALUES(?,?,?,?)',parts[2],u.id,b.text.trim(),new Date().toISOString().slice(0,10));return sendJson(res,201,{post:await getPost(parts[2],u.id)})}
 if(parts[1]==='posts'&&parts.length===4&&parts[3]==='helpful'&&method==='POST'){const u=await requireUser(req,res);if(!u)return;const exists=await get('SELECT id FROM posts WHERE id=? AND status=?',parts[2],'published');if(!exists)return sendJson(res,404,{error:'Guide not found.'});const vote=await get('SELECT post_id FROM helpful_votes WHERE post_id=? AND user_id=?',parts[2],u.id);if(vote)await run('DELETE FROM helpful_votes WHERE post_id=? AND user_id=?',parts[2],u.id);else await run('INSERT INTO helpful_votes(post_id,user_id) VALUES(?,?)',parts[2],u.id);return sendJson(res,200,{helpful:Number((await get('SELECT count(*) AS n FROM helpful_votes WHERE post_id=?',parts[2])).n),marked:!vote})}
 if(parts[1]==='posts'&&parts.length===4&&parts[3]==='rating'&&method==='POST'){const u=await requireUser(req,res);if(!u)return;const b=await readBody(req),score=Number(b.score);if(!Number.isInteger(score)||score<1||score>5)return sendJson(res,400,{error:'Choose a rating from 1 to 5 stars.'});if(!await get("SELECT id FROM posts WHERE id=? AND status='published'",parts[2]))return sendJson(res,404,{error:'Guide not found.'});await run('INSERT INTO ratings(post_id,user_id,score,created_at) VALUES(?,?,?,?) ON CONFLICT(post_id,user_id) DO UPDATE SET score=excluded.score,created_at=excluded.created_at',parts[2],u.id,score,new Date().toISOString());const summary=await get('SELECT round(avg(score),1) AS average,count(*) AS count FROM ratings WHERE post_id=?',parts[2]);return sendJson(res,200,{average:Number(summary.average),count:Number(summary.count)})}
 if(parts[1]==='bookmarks'&&method==='GET'){const u=await requireUser(req,res);if(!u)return;return sendJson(res,200,{ids:(await all('SELECT post_id FROM bookmarks WHERE user_id=?',u.id)).map(x=>x.post_id)})}
 if(parts[1]==='bookmarks'&&parts.length===3&&method==='POST'){const u=await requireUser(req,res);if(!u)return;const id=parts[2];if(!await get("SELECT id FROM posts WHERE id=? AND status='published'",id))return sendJson(res,404,{error:'Guide not found.'});const old=await get('SELECT 1 AS found FROM bookmarks WHERE post_id=? AND user_id=?',id,u.id);if(old)await run('DELETE FROM bookmarks WHERE post_id=? AND user_id=?',id,u.id);else await run('INSERT INTO bookmarks(post_id,user_id,created_at) VALUES(?,?,?)',id,u.id,new Date().toISOString());return sendJson(res,200,{saved:!old})}
 if(parts[1]==='dashboard'&&method==='GET'){const u=await requireUser(req,res);if(!u)return;const own=(await all(`${postSelect} WHERE p.author_id=? ORDER BY p.created_at DESC`,u.id,u.id)).map(r=>postShape(r,u.id)),savedRows=(await all(`${postSelect} JOIN bookmarks b ON b.post_id=p.id WHERE p.status='published' AND b.user_id=? ORDER BY b.created_at DESC`,u.id,u.id)).map(r=>postShape(r,u.id));return sendJson(res,200,{user:publicUser(u),posts:own,saved:savedRows})}
 if(parts[1]==='admin'&&parts.length===2&&method==='GET'){if(!await requireAdmin(req,res))return;const keys=['published','pending','users','views','comments','helpful','ratings','bookmarks','contributors'],sqls=["SELECT count(*) n FROM posts WHERE status='published'","SELECT count(*) n FROM posts WHERE status='pending'",'SELECT count(*) n FROM users','SELECT coalesce(sum(views),0) n FROM posts','SELECT count(*) n FROM comments','SELECT count(*) n FROM helpful_votes','SELECT count(*) n FROM ratings','SELECT count(*) n FROM bookmarks',"SELECT count(DISTINCT author_id) n FROM posts WHERE status='published'"],counts=await Promise.all(sqls.map(s=>get(s))),totals=Object.fromEntries(keys.map((key,i)=>[key,Number(counts[i].n)])),pending=(await all(`${postSelect} WHERE p.status='pending' ORDER BY p.created_at`,'')).map(r=>postShape(r,'')),people=(await all('SELECT * FROM users ORDER BY joined_at DESC')).map(publicUser),categories=await all('SELECT name,description FROM categories ORDER BY name');return sendJson(res,200,{totals,pending,users:people,categories})}
 if(parts[1]==='admin'&&parts[2]==='report'&&method==='GET'){if(!await requireAdmin(req,res))return;const csvCell=value=>{let text=String(value??'');if(/^[=+@\-\t\r]/.test(text))text="'"+text;return `"${text.replace(/"/g,'""')}"`},rows=await all(`SELECT p.id,p.title,p.trade,u.name AS author,p.status,p.created_at,p.views,(SELECT count(*) FROM comments c WHERE c.post_id=p.id) AS comments,(SELECT count(*) FROM helpful_votes h WHERE h.post_id=p.id) AS helpful,(SELECT coalesce(round(avg(r.score),1),0) FROM ratings r WHERE r.post_id=p.id) AS average_rating,(SELECT count(*) FROM ratings r WHERE r.post_id=p.id) AS rating_count FROM posts p JOIN users u ON u.id=p.author_id ORDER BY p.created_at DESC`),columns=['Guide ID','Title','Trade','Author','Status','Published date','Views','Comments','Helpful votes','Average star rating','Rating count'],csv=[columns,...rows.map(r=>[r.id,r.title,r.trade,r.author,r.status,r.created_at,r.views,r.comments,r.helpful,r.average_rating,r.rating_count])].map(row=>row.map(csvCell).join(',')).join('\r\n'),output='\uFEFF'+csv;res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="craftline-usage-report.csv"','Cache-Control':'no-store','Content-Length':Buffer.byteLength(output)});return res.end(output)}
 if(parts[1]==='admin'&&parts[2]==='posts'&&parts.length===4&&method==='PATCH'){if(!await requireAdmin(req,res))return;const b=await readBody(req);if(!['published','rejected'].includes(b.status))return sendJson(res,400,{error:'Invalid moderation status.'});const changed=(await run('UPDATE posts SET status=? WHERE id=?',b.status,parts[3])).changes;return sendJson(res,changed?200:404,{ok:Boolean(changed)})}
 if(parts[1]==='admin'&&parts[2]==='posts'&&parts.length===4&&method==='DELETE'){if(!await requireAdmin(req,res))return;const changed=(await run('DELETE FROM posts WHERE id=?',parts[3])).changes;return sendJson(res,changed?200:404,{ok:Boolean(changed)})}
 if(parts[1]==='admin'&&parts[2]==='users'&&parts.length===4&&method==='PATCH'){const admin=await requireAdmin(req,res);if(!admin)return;const b=await readBody(req);if(typeof b.suspended!=='boolean')return sendJson(res,400,{error:'Invalid profile status.'});if(parts[3]===admin.id)return sendJson(res,400,{error:'You cannot pause your own moderator account.'});const target=await get('SELECT role FROM users WHERE id=?',parts[3]);if(!target)return sendJson(res,404,{error:'Profile not found.'});if(target.role==='admin')return sendJson(res,403,{error:'Moderator profiles cannot be paused here.'});await run('UPDATE users SET suspended=? WHERE id=?',b.suspended?1:0,parts[3]);if(b.suspended)await run('DELETE FROM sessions WHERE user_id=?',parts[3]);return sendJson(res,200,{ok:true})}
 if(parts[1]==='admin'&&parts[2]==='categories'&&method==='POST'){if(!await requireAdmin(req,res))return;const b=await readBody(req);if(!validText(b.name,2,40))return sendJson(res,400,{error:'Category names must be 2–40 characters.'});try{await run('INSERT INTO categories(name,description) VALUES(?,?)',b.name.trim(),String(b.description||'').trim().slice(0,200));return sendJson(res,201,{ok:true})}catch{return sendJson(res,409,{error:'That category already exists.'})}}
 if(parts[1]==='admin'&&parts[2]==='categories'&&parts.length===4&&method==='DELETE'){if(!await requireAdmin(req,res))return;const count=Number((await get('SELECT count(*) n FROM posts WHERE trade=?',parts[3])).n);if(count)return sendJson(res,409,{error:'Move or remove the guides in this category first.'});const changed=(await run('DELETE FROM categories WHERE name=?',parts[3])).changes;return sendJson(res,changed?200:404,{ok:Boolean(changed)})}
 return sendJson(res,404,{error:'Not found.'});
}
function contentType(file){return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'})[path.extname(file)]||'application/octet-stream'}
function staticFile(req,res,url){let pathname;try{pathname=decodeURIComponent(url.pathname)}catch{return sendJson(res,400,{error:'Invalid path.'})}if(pathname==='/')pathname='/index.html';const file=path.resolve(PUBLIC_DIR,'.'+pathname);if(!file.startsWith(PUBLIC_DIR+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404,{'Content-Type':'text/plain'});return res.end('Not found')}const html=file.endsWith('.html'),versioned=url.searchParams.has('v'),compressible=/\.(?:html|js|css|svg|json)$/i.test(file),gzip=compressible&&/\bgzip\b/.test(req.headers['accept-encoding']||'');res.setHeader('Content-Type',contentType(file));res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control',html?'no-cache':versioned?'public, max-age=31536000, immutable':'public, max-age=3600');if(gzip){res.setHeader('Content-Encoding','gzip');res.setHeader('Vary','Accept-Encoding')}res.writeHead(200);const source=fs.createReadStream(file);if(gzip)source.pipe(createGzip()).pipe(res);else source.pipe(res)}
const server=express();
server.disable('x-powered-by');
server.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: https://res.cloudinary.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://player.vimeo.com; base-uri 'self'; frame-ancestors 'none'");next()});
server.use(async(req,res)=>{const url=new URL(req.url,'http://localhost');try{if(url.pathname.startsWith('/api/')){if(!['GET','HEAD','OPTIONS'].includes(req.method)){const origin=req.headers.origin;if(origin&&origin!==`http://${req.headers.host}`&&origin!==`https://${req.headers.host}`)return sendJson(res,403,{error:'Cross-origin request blocked.'});if(['POST','PUT','PATCH'].includes(req.method)&&!req.headers['content-type']?.includes('application/json'))return sendJson(res,415,{error:'Send a JSON request.'})}return await api(req,res,url)}return staticFile(req,res,url)}catch(error){if(!res.headersSent)sendJson(res,error.status||500,{error:(error.status||!PROD)?error.message:'Server error.'});else res.destroy();if(!PROD)console.error(error)}});

async function ensureAdmin(){const email=process.env.ADMIN_EMAIL,password=process.env.ADMIN_PASSWORD;if(!email&&!password)return;if(!email||!password||password.length<16)throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 16 characters) together.');const existing=await get('SELECT id FROM users WHERE email=?',email.toLowerCase()),salt=crypto.randomBytes(16).toString('hex'),derived=passwordHash(password,salt).toString('hex');await run("UPDATE users SET role='member' WHERE role='admin'");if(existing){await run("UPDATE users SET role='admin',suspended=0,password_salt=?,password_hash=? WHERE id=?",salt,derived,existing.id);return}const id=crypto.randomUUID();await run('INSERT INTO users(id,name,email,password_salt,password_hash,trade,experience,role,joined_at) VALUES(?,?,?,?,?,?,?,?,?)',id,'Platform Moderator',email.toLowerCase(),salt,derived,'Platform team','Moderator','admin',new Date().toISOString().slice(0,10))}
const parsedWorkers=Number.parseInt(process.env.WEB_CONCURRENCY||'1',10);
const WORKERS=Number.isFinite(parsedWorkers)?Math.max(1,Math.min(parsedWorkers,8)):1;
let shuttingDown=false;
function startWorker(){server.listen(PORT,()=>{if(!cluster.isPrimary)console.log(`Craftline worker ${cluster.worker.id} listening on port ${PORT}`)})}
async function boot(){
 if(PROD&&!DATABASE_URL)throw new Error('Production requires DATABASE_URL pointing to shared PostgreSQL storage.');
 if(PROD&&[process.env.CLOUDINARY_CLOUD_NAME,process.env.CLOUDINARY_API_KEY,process.env.CLOUDINARY_API_SECRET].some(value=>!value))throw new Error('Production requires CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET for Cloudinary media storage.');
 await initializeDatabase(cluster.isPrimary);
 if(cluster.isPrimary){await seedData();await ensureAdmin()}
 if(!cluster.isPrimary){startWorker();return}
 if(WORKERS===1){startWorker();console.log(`Craftline running at http://localhost:${PORT} (${DATABASE_URL?'PostgreSQL':'SQLite'})`);return}
 if(pool){await pool.end();pool=null}else if(sqlite){sqlite.close();sqlite=null}
 for(let i=0;i<WORKERS;i++)cluster.fork();
 cluster.on('online',worker=>console.log(`Craftline worker ${worker.id} online`));
 cluster.on('exit',(worker,code,signal)=>{if(shuttingDown)return;console.error(`Worker ${worker.id} exited (${signal||code}); starting a replacement.`);cluster.fork()});
 console.log(`Craftline running at http://localhost:${PORT} with ${WORKERS} workers (${DATABASE_URL?'PostgreSQL':'SQLite'})`);
}
if(cluster.isPrimary){
 const shutdown=()=>{if(shuttingDown)return;shuttingDown=true;for(const worker of Object.values(cluster.workers||{}))worker?.kill('SIGTERM');setTimeout(()=>process.exit(0),5000).unref()};
 process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
boot().catch(e=>{console.error(e.message);process.exit(1)});


