import test from 'node:test';
import {serve} from '../src/server.mjs';
test('core', () => { assert.equal(serve(), 3); });
