import { chromium } from 'playwright-core';
const ZIP='/home/ubuntu/projects/fb-marketplace-relister-v3.7.1.zip';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
let p = ctx.pages().find(x => x.url().includes('devconsole')) || ctx.pages()[0];
await p.bringToFront();
// go to Package tab
try { await p.getByText('Package',{exact:true}).first().click({timeout:8000}); await p.waitForTimeout(3000); } catch(e){ console.log('pkg tab click:',e.message); }
console.log('at:', p.url());
// find file input (often hidden)
const inputs = await p.locator('input[type="file"]').count();
console.log('file inputs found:', inputs);
if (inputs>0){
  await p.locator('input[type="file"]').first().setInputFiles(ZIP);
  console.log('zip set, waiting for upload...');
  await p.waitForTimeout(9000);
}
const txt = await p.evaluate(()=>document.body.innerText.slice(0,700));
console.log('--- after ---\n', txt);
await p.screenshot({ path:'/home/ubuntu/docs/screenshots/pkg-upload.png', fullPage:true });
await b.close();
