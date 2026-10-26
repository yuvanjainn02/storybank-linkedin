import test from 'node:test';
import assert from 'node:assert/strict';
import { handleHostedRequest } from '../server/hosted-http.mjs';
import { personalWorkspaceId } from '../server/hosted-d1.mjs';
import { createD1Fixture } from './support/d1-fixture.mjs';
import { TEST_SITE_ORIGIN, TEST_DEPLOYMENT_ENV } from './support/deployment-fixture.mjs';
function fixture(t) {
  const f=createD1Fixture();t.after(()=>f.close());
  const request=async(owner,path,body)=>{
    const r=await handleHostedRequest(new Request(TEST_SITE_ORIGIN+path,{method:body?'POST':'GET',headers:{origin:TEST_SITE_ORIGIN,'content-type':'application/json','x-storybank-request':'1','x-storybank-workspace':personalWorkspaceId(owner)},...(body?{body:JSON.stringify(body)}:{})}),{user:{userId:owner},db:f.db,env:TEST_DEPLOYMENT_ENV});
    return {status:r.status,body:await r.json()};
  };
  return {request,read:async(owner)=>(await request(owner,'/api/workspace')).body,command:(owner,operation,args)=>request(owner,'/api/command',{operation,args})};
}
test('HTTP research status follows only this owner’s saved profile, never submitted status claims',async t=>{
  const f=fixture(t);const none=await f.read('alice');assert.equal(none.creatorResearch.collectionStatus,'no_references');assert.equal(none.creatorResearch.profileVersion,0);
  const saved=await f.command('alice','saveWritingProfile',[{creators:[{name:'Fictional writer',notes:''}]},{expectedVersion:0}]);assert.equal(saved.status,200);
  const a=await f.read('alice'),b=await f.read('bob');assert.equal(a.creatorResearch.collectionStatus,'references_saved');assert.equal(a.creatorResearch.profileVersion,1);assert.equal(a.creatorResearch.researchStatus,'not_started');assert.equal(a.creatorResearch.reviewedSourceCount,0);assert.equal(a.creatorResearch.automaticResearchAvailable,false);assert.equal(b.creatorResearch.referenceCount,0);
  assert.equal('creatorResearch' in a.workspace,false);assert.equal('creatorResearch' in a.workspace.data.writingProfileVersions[0].preferences,false);
  for(const value of [{researchStatus:'complete'},{creatorResearch:{researchStatus:'complete'}},{owner:'bob'}])assert.equal((await f.command('alice','saveWritingProfile',[{...value,creators:[]},{expectedVersion:1}])).status,400);
  assert.equal((await f.read('alice')).creatorResearch.referenceCount,1);
});
test('HTTP research status refreshes after edits, resets and workspace deletion without a persisted job',async t=>{
  const f=fixture(t);await f.command('alice','saveWritingProfile',[{creators:[{name:'One',notes:''}]},{expectedVersion:0}]);
  await f.command('alice','saveWritingProfile',[{creators:[{name:'One',notes:''},{profileUrl:'https://www.linkedin.com/in/fictional-two',notes:''}]},{expectedVersion:1}]);
  let a=await f.read('alice');assert.equal(a.creatorResearch.profileVersion,2);assert.equal(a.creatorResearch.referenceCount,2);assert.deepEqual(a.workspace.data.jobs,[]);
  assert.equal((await f.command('alice','resetWritingProfile',[{expectedVersion:2}])).status,200);a=await f.read('alice');assert.equal(a.creatorResearch.profileVersion,3);assert.equal(a.creatorResearch.collectionStatus,'no_references');
  assert.equal((await f.request('alice','/api/delete',{confirmation:'DELETE_MY_WORKSPACE_DATA'})).status,200);a=await f.read('alice');assert.equal(a.creatorResearch.profileVersion,0);assert.equal(a.creatorResearch.referenceCount,0);
});
