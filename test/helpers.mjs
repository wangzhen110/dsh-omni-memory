import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let counter = 0;

/**
 * Boot the plugin against a throwaway DSH_HOME and return stubs for every host
 * surface it registers on. Each call uses a fresh module instance so module
 * level caches (store, profile cache) never leak between cases.
 */
export async function boot(options = {}) {
  const home = options.home ?? mkdtempSync(path.join(tmpdir(), 'omni-test-'));
  process.env.DSH_HOME = home;
  counter += 1;
  const mod = await import(`../index.js?case=${counter}-${Date.now()}`);

  const tools = new Map();
  const listeners = new Map();
  const routes = [];
  let section = null;

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    on(name, handler) {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
    get(name) {
      if (name === 'systemPrompt') {
        return {
          section(value) {
            section = value;
            return () => { section = null; };
          },
        };
      }
      if (name === 'webServer') {
        return {
          register(route) {
            routes.push(route);
            return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1); };
          },
        };
      }
      if (name === 'llm') return options.llm;
      return undefined;
    },
    effect(fn) {
      fn();
      return () => {};
    },
  };

  mod.apply(ctx);

  const call = async (name, args = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`missing tool ${name}`);
    const value = await tool.execute(args, {});
    const rendered = tool.output.render(args, value);
    return { value, text: rendered.map(block => block.text).join('\n') };
  };

  const fire = (type, text, seq = 1, sessionId = 'session-test') => {
    const listener = listeners.get('session/event');
    if (!listener) throw new Error('capture listener is not registered');
    listener({ id: sessionId }, {
      type, seq, time: Date.now(),
      data: { message: { content: [{ type: 'text', text }] } },
    });
  };

  const fireRaw = (event) => {
    const listener = listeners.get('session/event');
    if (!listener) throw new Error('capture listener is not registered');
    listener({ id: 'session-test' }, event);
  };

  const route = routePath => {
    const found = routes.find(item => item.path === routePath);
    if (!found) throw new Error(`missing route ${routePath}`);
    return found;
  };

  const fireWithCwd = (cwd, type, text, seq = 1, sessionId = 'session-test') => {
    const listener = listeners.get('session/event');
    if (!listener) throw new Error('capture listener is not registered');
    listener({ id: sessionId, header: { cwd } }, {
      type, seq, time: Date.now(),
      data: { message: { content: [{ type: 'text', text }] } },
    });
  };

  const fireInbox = (text, agentId = 'agent-test') => {
    const listener = listeners.get('agent/inbox/claimed');
    if (!listener) throw new Error('auto-recall listener is not registered');
    listener({
      agent: { id: agentId },
      turn: 1,
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  };

  return { home, tools, listeners, routes, call, fire, fireInbox, fireRaw, fireWithCwd, route, section: () => section };
}

export function fakeRes() {
  const state = { statusCode: 0, body: '', headers: {} };
  const res = {
    setHeader(key, value) { state.headers[String(key).toLowerCase()] = value; },
    end(chunk) { if (chunk !== undefined) state.body += String(chunk); },
  };
  Object.defineProperty(res, 'statusCode', {
    get: () => state.statusCode,
    set: value => { state.statusCode = value; },
  });
  return { res, state, json() { return JSON.parse(state.body); } };
}

export function fakeReq(url, address = '127.0.0.1') {
  return { method: 'GET', url, socket: { remoteAddress: address } };
}

/** Minimal POST request with a JSON body; emits data/end on next microtask. */
export function fakePost(body, address = '127.0.0.1', url = '/omni-memory/forget') {
  const handlers = new Map();
  const req = {
    method: 'POST',
    url,
    socket: { remoteAddress: address },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return req;
    },
  };
  queueMicrotask(() => {
    const payload = JSON.stringify(body ?? {});
    for (const handler of handlers.get('data') ?? []) handler(payload);
    for (const handler of handlers.get('end') ?? []) handler();
  });
  return req;
}

/**
 * POST whose stream the host already consumed (the real DSH web server behaves
 * this way): no `data`/`end` events ever arrive.
 */
export function fakePostConsumed(url, address = '127.0.0.1') {
  return {
    method: 'POST',
    url,
    complete: true,
    readable: false,
    socket: { remoteAddress: address },
    on() { return this; },
  };
}
