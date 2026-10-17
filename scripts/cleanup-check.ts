import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import neo4j from 'neo4j-driver';
async function main(){
 config({quiet:true});
 const ids:unknown=JSON.parse(await readFile('artifacts/focus-check-ids.json','utf8'));
 if(!Array.isArray(ids)||!ids.length||!ids.every(id=>typeof id==='string'))throw new Error('No test IDs to remove');
 const driver=neo4j.driver(process.env.NEO4J_URI!,neo4j.auth.basic(process.env.NEO4J_USERNAME!,process.env.NEO4J_PASSWORD!));
 try{
  const result=await driver.executeQuery('MATCH (n) WHERE n.id IN $ids AND any(label IN labels(n) WHERE label IN $labels) OPTIONAL MATCH (n)-[:HAS_MESSAGE|HAS_OBSERVATION]->(child) WITH collect(DISTINCT n)+collect(DISTINCT child) AS nodes UNWIND nodes AS node WITH DISTINCT node DETACH DELETE node RETURN count(*) AS removed', {ids,labels:['TGCConversation','TGCMessage','TGCGoal','TGCFocusSession','TGCObservation','TGCGoalDetail']},{database:process.env.NEO4J_DATABASE||'neo4j'});
  console.log('Removed only temporary desktop-check records:',result.records[0]?.get('removed').toString());
 }finally{await driver.close();}
}
main().catch(()=>{console.error('Test cleanup failed; no credentials logged.');process.exitCode=1;});
