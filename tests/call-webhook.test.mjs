import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { callEventUpdate, verifyCallSignature } from '../dist/routes/callWebhook.js';
test('voice signatures require exact bytes, a fresh timestamp, and a matching secret', () => {
  const now = Date.now(), timestamp = Math.floor(now/1000), body = Buffer.from('{ "call_id": "call-1" }');
  const sign = t => `t=${t},v1=${createHmac('sha256','secret').update(`${t}.`).update(body).digest('hex')}`;
  assert.equal(verifyCallSignature(body,sign(timestamp),'secret',now),true);
  assert.equal(verifyCallSignature(Buffer.concat([body,Buffer.from(' ')]),sign(timestamp),'secret',now),false);
  assert.equal(verifyCallSignature(body,sign(timestamp),'wrong',now),false);
  assert.equal(verifyCallSignature(body,sign(timestamp-301),'secret',now),false);
  assert.equal(verifyCallSignature(body,'t=abc,v1=00','secret',now),false);
});
test('call-ended and recording events preserve zero values and do not overwrite unrelated fields', () => {
  const end = callEventUpdate('call.ended',{call_id:'call-1',status:'failed',duration_seconds:0,cost_cents:0,transcript_text:''});
  assert.equal(end.updates.duration_seconds,0); assert.equal(end.updates.cost_cents,0); assert.equal(end.updates.transcript,'');
  assert.equal('recording_url' in end.updates,false);
  const recording = callEventUpdate('recording.ready',{call_id:'call-1',audio_url:'https://example.test/audio.wav'});
  assert.deepEqual(recording.updates,{recording_url:'https://example.test/audio.wav'});
  assert.equal(callEventUpdate('tts.batch.completed',{}),null);
});
