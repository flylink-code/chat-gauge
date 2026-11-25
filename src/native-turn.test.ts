import { assert, test } from 'orca/testing'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readNativeTurn } from './native-turn'
import { metrics, status, agentLabel } from './format'
import { emptySnapshot } from './protocol'

const id = '00000000-0000-0000-0000-000000000001'
test('turn clock rejects incomplete/failed/cleared turns and never reads another epoch or child', async () => {
  const root = await mkdtemp(join(tmpdir(),'gauge-clock-'))
  try {
    await mkdir(join(root,'orca'))
    const db = new DatabaseSync(join(root,'orca','agent-session-domain.db'))
    try {
      db.exec(`create table journal_chat_state(session_id,epoch);create table journal_items(session_id,epoch,kind,hidden,root,subagent_row,turn_marker,queue_command_turn,context_clear,sequence,ordinal,payload_json)`)
      db.prepare('insert into journal_chat_state values (?,?)').run(id,'active')
      const insert = db.prepare('insert into journal_items values (?,?,?,?,?,?,?,?,?,?,?,?)')
      const body = { startedAt: 1000, completedAt: 2500, durationMs: 1450, state: 'completed', outcome: 'success' }
      const add = (seq:number, data:object, epoch='active', child=0, clear=0) => insert.run(id,epoch,'turn',0,1,child,1,0,clear,seq,seq,JSON.stringify({body:data}))
      add(1,body); add(2,{},'old'); add(3,{},'active',1)
      assert.deepEqual(await readNativeTurn(root,id), {startedAt:1000,completedAt:2500,durationMs:1450})
      add(4,{...body,state:'running'}); assert.equal(await readNativeTurn(root,id),null)
      add(5,{...body,outcome:'failure'}); assert.equal(await readNativeTurn(root,id),null)
      add(6,{...body,durationMs:undefined}); assert.equal((await readNativeTurn(root,id))?.durationMs,1500)
      add(7,{},'active',0,1); assert.equal(await readNativeTurn(root,id),null)
    } finally {db.close()}
  } finally {await rm(root,{recursive:true,force:true})}
})
test('provider wall clock rates never populate context, cache or Claude request timing', () => {
  for (const scope of ['turn','message'] as const) {
    const snapshot = {...emptySnapshot,providerRate:{scope,outputTokens:12,durationMs:1500,completedAt:2000}}
    assert.equal(metrics(snapshot).used,null); assert.equal(metrics(snapshot).cache,null)
    assert.equal(status(snapshot).text,'≈8.0 tok/s'); assert.ok(status(snapshot).tooltip.includes(scope))
  }
  assert.equal(agentLabel('copilot'),'GitHub Copilot'); assert.equal(agentLabel('futureAgent'),'futureAgent')
})
