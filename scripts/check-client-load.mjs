#!/usr/bin/env node
/**
 * Client module smoke test: loads client.js in a fake loader, then runs apply()
 * with stub slots/locale services. Catches undefined references and other
 * top-level apply failures without needing the Electron renderer.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const source = readFileSync(path.join(root, 'client.js'), 'utf8');

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Component: class Component { constructor(props) { this.props = props ?? {}; } },
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useRef: value => ({ current: value }),
  useMemo: value => (typeof value === 'function' ? value() : value),
  useCallback: value => value,
};

const context = {
  console,
  window: {},
  document: {},
  localStorage: { getItem: () => null, setItem: () => {} },
  setTimeout,
  clearTimeout,
};
context.window.localStorage = context.localStorage;
vm.createContext(context);

let exported;
context.window.__ModuleLoader__ = {
  load(definition) {
    exported = definition.factory(name => {
      if (name === 'react') return React;
      throw new Error(`unexpected require: ${name}`);
    });
  },
};

try {
  vm.runInContext(source, context, { filename: 'client.js' });
  if (!exported) throw new Error('module did not export through __ModuleLoader__');
  const registered = [];
  const ctx = {
    effect(fn) { const dispose = fn(); return dispose; },
    get() { return undefined; },
    slots: {
      inject(name, factory) { factory(); return () => {}; },
      register(meta, component) { registered.push({ meta, component }); return () => {}; },
    },
    locale: {
      register() { return () => {}; },
      bind() { return key => key; },
      subscribe() { return () => {}; },
    },
  };
  exported.apply(ctx);
  if (!registered.length) throw new Error('no slots registered');
  console.log(`ok   client module applies and registers ${registered.length} slots`);
} catch (error) {
  console.error('FAIL client module smoke test:', error?.stack ?? error);
  process.exit(1);
}
