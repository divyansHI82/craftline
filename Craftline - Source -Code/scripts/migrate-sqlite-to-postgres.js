// Copy Craftline content from the local SQLite database to a PostgreSQL database.
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {Pool}=require('pg');

const root=path.resolve(__dirname,'..');
for(const row of (fs.existsSync(path.join(root,'.env'))?fs.readFileSync(path.join(root,'.env'),'utf8'):'').split(/\r?\n/)){
 const match=row.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
 if(match&&process.env[match[1]]===undefined)process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
}

async function main(){
 const sourcePath=path.resolve(process.argv[2]||process.env.DATABASE_PATH||path.join(root,'data','craftline.sqlite'));
 if(!process.env.DATABASE_URL)throw new Error('Set DATABASE_URL in .env to your PostgreSQL connection string first.');
 if(!fs.existsSync(sourcePath))throw new Error(`SQLite database not found: ${sourcePath}`);
 const sqlite=new DatabaseSync(sourcePath),pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSLMODE==='require'?{rejectUnauthorized:process.env.PGSSL_REJECT_UNAUTHORIZED!=='false'}:undefined});
 const tables=['categories','posts','comments','helpful_votes','ratings','bookmarks'];
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const userIds=new Map();
  for(const user of sqlite.prepare('SELECT * FROM users').all()){
   let target=(await client.query('SELECT id FROM users WHERE id=$1 OR lower(email)=lower($2) LIMIT 1',[user.id,user.email])).rows[0];
   if(!target){const columns=Object.keys(user),values=columns.map(column=>user[column]),placeholders=columns.map((_,i)=>`$${i+1}`).join(',');await client.query(`INSERT INTO users (${columns.map(c=>`"${c}"`).join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,values);target=(await client.query('SELECT id FROM users WHERE id=$1 OR lower(email)=lower($2) LIMIT 1',[user.id,user.email])).rows[0]}
   if(target)userIds.set(user.id,target.id);
  }
  for(const table of tables){
   const rows=sqlite.prepare(`SELECT * FROM "${table}"`).all();
   if(!rows.length)continue;
   const columns=Object.keys(rows[0]);
   for(const row of rows){
    const values=columns.map(column=>{const value=row[column];return ['author_id','user_id'].includes(column)?(userIds.get(value)||value):value});
    const placeholders=columns.map((_,i)=>`$${i+1}`).join(',');
    await client.query(`INSERT INTO "${table}" (${columns.map(c=>`"${c}"`).join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,values);
   }
   console.log(`Copied ${rows.length} ${table}.`);
  }
  await client.query("SELECT setval(pg_get_serial_sequence('comments','id'), GREATEST(COALESCE((SELECT max(id) FROM comments),1),1), EXISTS(SELECT 1 FROM comments))");
  await client.query('COMMIT');
  console.log('SQLite content migration completed. Sessions and temporary login limits were intentionally left out; users should sign in again after migration.');
 }catch(error){await client.query('ROLLBACK');throw error}
 finally{client.release();sqlite.close();await pool.end()}
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
