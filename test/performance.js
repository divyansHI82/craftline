const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'craftline-perf-'));
const port = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const chosen = server.address().port; server.close(() => resolve(chosen)); });
});
const percentile = (values, p) => values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)];
async function main() {
  const selectedPort = await port(), base = `http://127.0.0.1:${selectedPort}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(selectedPort), DATABASE_URL: '', DATABASE_PATH: path.join(temp, 'craftline.sqlite'), ADMIN_EMAIL: 'benchmark@craftline.test', ADMIN_PASSWORD: 'BenchmarkModerator!2026', NODE_ENV: 'test', WEB_CONCURRENCY: '2' }, stdio: ['ignore','ignore','pipe'] });
  let logs = '';
  child.stderr.on('data', chunk => logs += chunk);
  try {
    let ready = false;
    for (let attempt=0; attempt<80; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited during startup: ${logs}`);
      try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Server did not start: ${logs}`);
    const measure = async (label, url, headers={}) => {
      const times=[]; let bytes=0;
      for(let batch=0;batch<5;batch++){const results=await Promise.all(Array.from({length:8},async()=>{const start=performance.now(),response=await fetch(`${base}${url}`,{headers});if(!response.ok)throw new Error(`${url} returned ${response.status}`);const body=await response.arrayBuffer();return {elapsed:performance.now()-start,bytes:body.byteLength}}));for(const result of results){times.push(result.elapsed);bytes+=result.bytes}}
      return `${label}: median ${percentile(times,.5).toFixed(1)} ms, p95 ${percentile(times,.95).toFixed(1)} ms, average decoded body ${(bytes/40/1024).toFixed(1)} KB`;
    };
    console.log('Local two-worker development benchmark (40 requests at concurrency 8; use as a baseline, not a production SLA):');
    console.log(await measure('Knowledge feed API','/api/bootstrap'));
    console.log(await measure('Compressed app script','/app.js?v=benchmark',{ 'accept-encoding':'gzip' }));
  } finally {
    child.kill();
    await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,1000)});
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1});
