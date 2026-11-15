import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), 'omni-test-'));

const mod = await import('./index.js');

const registered = new Map();
const listeners = new Map();
let promptSection = null;

const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  },
  on(name, handler) {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  },
  get(name) {
    if (name === 'systemPrompt') {
      return {
        section(section) {
          promptSection = section;
          return () => { promptSection = null; };
        },
      };
    }
    return undefined;
  },
  effect(fn) { fn(); return () => {}; },
};

mod.apply(ctx);
console.log('tools:', [...registered.keys()].join(', '));
console.log('capture listener:', listeners.has('session/event'));
console.log('prompt section:', promptSection ? promptSection.name : 'MISSING');

const call = async (name, args) => {
  const tool = registered.get(name);
  const value = await tool.execute(args, {});
  return { value, rendered: tool.output.render(args, value).map(block => block.text).join('\n') };
};

// Simulate committed session events (post-commit feed shape).
const fire = (seq, type, text) => listeners.get('session/event')(
  { id: 'session-test' },
  { type, seq, time: Date.now(), data: { message: { content: [{ type: 'text', text }] } } },
);

fire(1, 'user/message', '以后别问我确认，直接动手，我不喜欢被反复打扰');
fire(2, 'assistant/message', '明白，后续默认直接执行，只有不可逆操作才确认');

const afterCapture = await call('memory_search', { query: '反复打扰' });
console.log('\n=== captured transcript search ===');
console.log(afterCapture.rendered);

const written = await call('memory_write', {
  kind: 'note', text: '用户偏好：直接执行，不做多余确认', importance: 0.95, scope: 'global',
});
console.log('\n=== write ===', written.rendered);

console.log('\n=== injected prompt section ===');
console.log(promptSection ? promptSection.text() : 'MISSING');

const stats = await call('memory_profile', {});
console.log('\n=== stats ===');
console.log(JSON.stringify(stats.value.stats));
