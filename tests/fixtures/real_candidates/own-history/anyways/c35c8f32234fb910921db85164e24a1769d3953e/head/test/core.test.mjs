import test from 'node:test';
import assert from 'node:assert/strict';
import { seed, storyValid, transitionAllowed, validUrl, runScheduler } from '../src/server.mjs';

test('publishing validation requires structured source, topic, metadata, and core fields',()=>{const db=seed(),s={...db.stories[0],topic_ids:[],seo_title:'',seo_description:''};db.sources=db.sources.filter(x=>x.story_id!==s.id);assert.ok(storyValid(db,s).length>=4);});
test('contributors cannot publish but editors can',()=>{const db=seed(),s=db.stories[0],con=db.users.find(x=>x.role==='contributor'),ed=db.users.find(x=>x.role==='editor');s.author_id=con.id;assert.equal(transitionAllowed(con,s,'published'),false);assert.equal(transitionAllowed(ed,s,'published'),true);});
test('URL validation and scheduled publishing are safe to repeat',()=>{assert.equal(validUrl('https://example.com'),true);assert.equal(validUrl('nope'),false);const db=seed(),s=db.stories[0];s.status='scheduled';s.scheduled_for=new Date(Date.now()-1000).toISOString();s.published_at=null;assert.equal(runScheduler(db),1);assert.equal(runScheduler(db),0);assert.equal(s.status,'published');});
