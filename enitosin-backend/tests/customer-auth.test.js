const assert=require('assert'); const a=require('../customer-auth.js');
(async()=>{
 const h=await a.hashPassword('Secret123'); assert(h.startsWith('scrypt$')); assert(!h.includes('Secret123'));
 assert.strictEqual(await a.verifyPassword('Secret123',h),true); assert.strictEqual(await a.verifyPassword('secret123',h),false);
 assert.notStrictEqual(await a.hashPassword('Secret123'),h); // random salt
 assert.strictEqual(await a.verifyPassword('x','garbage'),false);
 const t=a.signSession({id:5,passwordHash:h},'s3cret'); const p=a.verifySession(t,'s3cret'); assert.strictEqual(p.id,5);
 assert.strictEqual(a.verifySession(t,'other-secret'),null);
 const [pl,sig]=t.split('.'); const forged=Buffer.from(JSON.stringify({id:1,exp:Date.now()+1e9,pv:'x'})).toString('base64url')+'.'+sig; assert.strictEqual(a.verifySession(forged,'s3cret'),null);
 const old=a.signSession({id:5,passwordHash:h},'s3cret',-1); assert.strictEqual(a.verifySession(old,'s3cret'),null);
 assert.strictEqual(a.verifySession(undefined,'s'),null); assert.strictEqual(a.verifySession('a.b','s'),null);
 assert.deepStrictEqual(a.parseCookies('x=1; enitosin_session=abc%20d; y=2'),{x:'1',enitosin_session:'abc d',y:'2'});
 const c=a.sessionCookie('tok',{secure:true}); assert(/HttpOnly/.test(c)&&/SameSite=Lax/.test(c)&&/Secure/.test(c)); assert(/Max-Age=0/.test(a.sessionCookie('',{clear:true})));
 const r=a.newResetToken(); assert.strictEqual(r.token.length,64); assert.strictEqual(a.hashResetToken(r.token),r.hash); assert.notStrictEqual(r.token,r.hash);
 assert(a.passwordProblem('short')); assert.strictEqual(a.passwordProblem('longenough1'),null);
 assert(a.PHONE_RE.test('08012345678')&&a.PHONE_RE.test('+234 801 234 5678')&&!a.PHONE_RE.test('abc')&&!a.PHONE_RE.test('123'));
 console.log('AUTH UNIT TESTS PASSED'); process.exit(0);
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
