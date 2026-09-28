const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const root=path.resolve(__dirname,'..');
const node=process.execPath;
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'craftline-smoke-'));
const email=`learner-${Date.now()}@example.test`;
const password='LearnerSmokeTest!2026';
const adminEmail='moderator@craftline.test';
const adminPassword='ModeratorSmokeTest!2026';
const databasePath=path.join(tmp,'craftline.sqlite');

function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port))})})}
function cookie(response){const value=response.headers.get('set-cookie')||'';return value.split(';')[0]}
async function main(){
 const port=await freePort(),base=`http://127.0.0.1:${port}`;
 const child=spawn(node,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),DATABASE_URL:'',DATABASE_PATH:databasePath,ADMIN_EMAIL:adminEmail,ADMIN_PASSWORD:adminPassword,NODE_ENV:'test',WEB_CONCURRENCY:'2'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 try{
  let ready=false;for(let i=0;i<80;i++){if(child.exitCode!==null)throw new Error(`Server exited early:\n${logs}`);try{const r=await fetch(`${base}/api/health`);if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}assert.equal(ready,true,`Server did not start:\n${logs}`);
 const call=async(route,{method='GET',body,cookie:session,origin=base,acceptEncoding}={})=>{const headers={};if(body!==undefined){headers['content-type']='application/json'}if(session)headers.cookie=session;if(origin)headers.origin=origin;if(acceptEncoding)headers['accept-encoding']=acceptEncoding;const response=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});let data={};if((response.headers.get('content-type')||'').includes('application/json'))data=await response.json();else data=await response.text();return {response,data}};
  let r=await call('/');assert.equal(r.response.status,200);assert.match(r.data,/Craftline/);
  r=await call('/app.js',{acceptEncoding:'gzip'});assert.equal(r.response.status,200);assert.equal(r.response.headers.get('content-encoding'),'gzip');
  r=await call('/api/health');assert.equal(r.response.status,200);assert.equal(r.data.database,'sqlite');
  r=await call('/api/bootstrap');assert.equal(r.response.status,200);assert.equal(r.data.posts.length,7);assert.ok(r.data.categories.length>=6);assert.ok(r.data.posts.some(p=>p.videoUrl==='https://www.youtube-nocookie.com/embed/vRGn9MjQnGY'));
  r=await call('/api/admin');assert.equal(r.response.status,401);
  r=await call('/api/register',{method:'POST',body:{name:'Test Learner',email,trade:'Plumbing',experience:'Student / apprentice',password}});assert.equal(r.response.status,201,JSON.stringify(r.data));const memberCookie=cookie(r.response);assert.ok(memberCookie.includes('craftline_session='));assert.match(r.response.headers.get('set-cookie'),/HttpOnly/);assert.match(r.response.headers.get('set-cookie'),/SameSite=Lax/);
  r=await call('/api/register',{method:'POST',body:{name:'Test Learner',email,trade:'Plumbing',experience:'Student / apprentice',password}});assert.equal(r.response.status,409);
  r=await call('/api/dashboard',{cookie:memberCookie});assert.equal(r.response.status,200);assert.equal(r.data.posts.length,0);
  r=await call('/api/admin',{cookie:memberCookie});assert.equal(r.response.status,403);
  const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/C0cAAAAASUVORK5CYII=';
  const guide={title:'Smoke test plumbing pressure checklist',trade:'Plumbing',kind:'Field guide',summary:'A concise checklist for checking a small residential water pressure issue safely.',body:'Start by asking which fixtures are affected and checking the pressure at a known point with a suitable gauge. Inspect accessible shutoff valves and the filter or regulator according to its service instructions. Compare readings with local requirements and the appliance documentation. Stop and refer work to a licensed professional when the cause is unclear or the system may be contaminated.',image,videoUrl:'https://youtu.be/vRGn9MjQnGY',safety:true};
  r=await call('/api/posts',{method:'POST',body:guide,cookie:memberCookie});assert.equal(r.response.status,201,JSON.stringify(r.data));const postId=r.data.id;
  r=await call('/api/posts',{method:'POST',body:{...guide,title:'Another valid field video guide',videoUrl:'https://example.com/unsafe'},cookie:memberCookie});assert.equal(r.response.status,400);
  r=await call('/api/posts',{method:'POST',body:{...guide,title:'Invalid'},cookie:memberCookie,origin:'https://unexpected.example'});assert.equal(r.response.status,403);
  r=await call('/api/login',{method:'POST',body:{email:adminEmail,password:adminPassword}});assert.equal(r.response.status,200);const adminCookie=cookie(r.response);
  r=await call('/api/admin',{cookie:adminCookie});assert.equal(r.response.status,200);assert.ok(r.data.pending.some(p=>p.id===postId));assert.ok(r.data.users.some(u=>u.email===email));
  r=await call(`/api/admin/posts/${postId}`,{method:'PATCH',body:{status:'published'},cookie:adminCookie});assert.equal(r.response.status,200);
  r=await call(`/api/posts/${postId}`,{cookie:memberCookie});assert.equal(r.response.status,200);assert.equal(r.data.post.title,guide.title);assert.equal(r.data.post.image,image);assert.equal(r.data.post.videoUrl,'https://www.youtube-nocookie.com/embed/vRGn9MjQnGY');
  r=await call('/api/bootstrap',{cookie:memberCookie});assert.equal(r.response.status,200);assert.equal(r.data.posts.find(p=>p.id===postId).image,'','Feed bootstrap omits full image data; detail pages load it on demand.');
  r=await call(`/api/posts/${postId}/comments`,{method:'POST',body:{text:'Clear sequence and safety note.'},cookie:memberCookie});assert.equal(r.response.status,201);assert.equal(r.data.post.comments.length,1);
  r=await call(`/api/posts/${postId}/helpful`,{method:'POST',body:{},cookie:memberCookie});assert.equal(r.response.status,200,JSON.stringify(r.data));assert.equal(r.data.helpful,1);
  r=await call(`/api/posts/${postId}/rating`,{method:'POST',body:{score:4},cookie:memberCookie});assert.equal(r.response.status,200,JSON.stringify(r.data));assert.equal(r.data.average,4);assert.equal(r.data.count,1);
  r=await call(`/api/posts/${postId}/rating`,{method:'POST',body:{score:5},cookie:memberCookie});assert.equal(r.response.status,200);assert.equal(r.data.average,5);assert.equal(r.data.count,1,'A member updates their existing rating instead of creating a duplicate.');
  r=await call(`/api/posts/${postId}/rating`,{method:'POST',body:{score:6},cookie:memberCookie});assert.equal(r.response.status,400,'Ratings outside one to five stars are rejected.');
  r=await call(`/api/bookmarks/${postId}`,{method:'POST',body:{},cookie:memberCookie});assert.equal(r.response.status,200);assert.equal(r.data.saved,true);
  r=await call('/api/dashboard',{cookie:memberCookie});assert.equal(r.response.status,200);assert.equal(r.data.posts.length,1);assert.equal(r.data.saved.length,1);
  r=await call('/api/logout',{method:'POST',body:{},cookie:memberCookie});assert.equal(r.response.status,200);
  r=await call('/api/dashboard',{cookie:memberCookie});assert.equal(r.response.status,401);
  r=await call('/api/login',{method:'POST',body:{email,password}});assert.equal(r.response.status,200);const renewedMemberCookie=cookie(r.response);
  r=await call('/api/admin/categories',{method:'POST',body:{name:'Smoke fixtures',description:'Test category'},cookie:adminCookie});assert.equal(r.response.status,201);
  r=await call('/api/admin/categories',{method:'POST',body:{name:'Plumbing'},cookie:adminCookie});assert.equal(r.response.status,409);
  r=await call('/api/admin/categories/Plumbing',{method:'DELETE',cookie:adminCookie});assert.equal(r.response.status,409);
  r=await call('/api/admin/categories/Smoke%20fixtures',{method:'DELETE',cookie:adminCookie});assert.equal(r.response.status,200);
  r=await call('/api/admin',{cookie:adminCookie});assert.equal(r.response.status,200);assert.equal(r.data.totals.ratings,1);const member=r.data.users.find(u=>u.email===email);assert.ok(member);
  r=await call('/api/admin/report',{cookie:adminCookie});assert.equal(r.response.status,200);assert.match(r.response.headers.get('content-type'),/text\/csv/);assert.match(r.data,/Average star rating/);assert.match(r.data,/Smoke test plumbing pressure checklist/);
  r=await call(`/api/admin/users/${member.id}`,{method:'PATCH',body:{suspended:true},cookie:adminCookie});assert.equal(r.response.status,200);
  r=await call('/api/dashboard',{cookie:renewedMemberCookie});assert.equal(r.response.status,401);
  r=await call('/api/login',{method:'POST',body:{email,password}});assert.equal(r.response.status,403);
  r=await call('/api/posts',{method:'GET'});assert.equal(r.response.status,200);assert.ok(r.data.posts.some(p=>p.id===postId));
  console.log('Craftline smoke tests passed with two workers sharing SQLite: routes, compressed assets, lean feed responses, seed content, registration, sessions, RBAC, moderation, guides, comments, helpful votes, star ratings, usage report export, bookmarks, categories, and suspended accounts.');
 }catch(error){console.error(logs);throw error}finally{child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,1000)});}
 const {DatabaseSync}=require('node:sqlite');const persisted=new DatabaseSync(databasePath);assert.equal(persisted.prepare("SELECT status FROM posts WHERE title='Smoke test plumbing pressure checklist'").get().status,'published');assert.equal(persisted.prepare('SELECT count(*) n FROM comments WHERE post_id=(SELECT id FROM posts WHERE title=?)').get('Smoke test plumbing pressure checklist').n,1);assert.ok(persisted.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_posts_status_created'").get());persisted.close();console.log('SQLite persistence and query-index checks passed after server restart.');
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1});
