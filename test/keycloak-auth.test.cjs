require('./keycloak.setup.cjs');
require('reflect-metadata');
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync,createHmac,sign}=require('node:crypto');
const nock=require('nock');
const {Test}=require('@nestjs/testing');
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
let app,base,published=0;

/** Creates local RSA service/HMAC member fixtures; optional claims override defaults; returns JWT or throws signing errors. */
function token(claims={},member=false) {
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const now=Math.floor(Date.now()/1000);
  const payload=member?{iss:'https://members.example.test',userId:42,sub:'member-42',roles:['administrator'],iat:now,exp:now+120,...claims}
    :{iss:process.env.KEYCLOAK_ISSUER,aud:process.env.KEYCLOAK_AUDIENCE,azp:'test-client',sub:'service-account',
      gty:'client-credentials',scope:'write:autopilot',iat:now,exp:now+300,...claims};
  const value=encode({alg:member?'HS256':'RS256',kid:member?undefined:'autopilot-test'})+'.'+encode(payload);
  const signature=member?createHmac('sha256',process.env.AUTH_SECRET).update(value).digest():sign('RSA-SHA256',Buffer.from(value),keys.privateKey);
  return value+'.'+signature.toString('base64url');
}
before(async()=>{
  const url=new URL(process.env.KEYCLOAK_ISSUER);
  nock(url.origin).persist().get(url.pathname+'/protocol/openid-connect/certs')
    .reply(200,{keys:[{...keys.publicKey.export({format:'jwk'}),kid:'autopilot-test',alg:'RS256',use:'sig'}]});
  const {KafkaController}=require('../dist/src/kafka/controllers/kafka.controller');
  const {AutopilotProducer}=require('../dist/src/kafka/producers/autopilot.producer');
  const {AuthModule}=require('../dist/src/auth/auth.module');
  const fixture=await Test.createTestingModule({imports:[AuthModule],controllers:[KafkaController],providers:[
    {provide:AutopilotProducer,useValue:{sendCommand:async()=>{published++;}}},
  ]}).compile();
  app=fixture.createNestApplication();await app.listen(0,'127.0.0.1');base=await app.getUrl();
});
after(async()=>{nock.cleanAll();if(app)await app.close();});

/** Calls the real compiled Kafka command route with an optional bearer; returns the HTTP response; transport errors propagate. */
const command=credential=>fetch(base+'/kafka/command',{method:'POST',headers:{'content-type':'application/json',...(credential?{authorization:'Bearer '+credential}:{})},
  body:JSON.stringify({timestamp:new Date().toISOString(),payload:{command:'test',projectId:1}})});

test('manual Kafka controls reject missing credentials and insufficient machine scopes',async()=>{
  const before=published;assert.equal((await command()).status,401);
  assert.equal((await command(token({scope:'read:groups'}))).status,403);assert.equal(published,before);
});
test('explicit service grant and administrator member can invoke controls',async()=>{
  const before=published;assert.equal((await command(token())).status,201);
  assert.equal((await command(token({},true))).status,201);assert.equal(published,before+2);
});
test('member OAuth scopes cannot replace the administrator role',async()=>{
  assert.equal((await command(token({roles:['member'],scope:'write:autopilot'},true))).status,403);
});
test('wrong audience, role-bearing machine and malformed signatures are unauthorized',async()=>{
  for(const bad of [token({aud:'wrong'}),token({roles:['administrator']}),'invalid'])assert.equal((await command(bad)).status,401);
});
test('outbound provider validates issued tokens, caches them, and clears on demand',async()=>{
  const {Auth0Service}=require('../dist/src/auth/auth0.service');
  const provider=new Auth0Service();const issued=token();
  const endpoint=new URL(process.env.KEYCLOAK_TOKEN_URL);
  const first=nock(endpoint.origin).post(endpoint.pathname).reply(200,{access_token:issued,expires_in:300,token_type:'Bearer'});
  assert.equal(await provider.getAccessToken(),issued);assert.equal(await provider.getAccessToken(),issued);assert.ok(first.isDone());
  provider.clearTokenCache();
  const second=nock(endpoint.origin).post(endpoint.pathname).reply(200,{access_token:issued,expires_in:300,token_type:'Bearer'});
  assert.equal(await provider.getAccessToken(),issued);assert.ok(second.isDone());
});
