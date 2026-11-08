import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingKeys } from './locale.ts';
import {
  matchSlash,
  resolveSlash,
  SLASH_CATALOG,
  SLASH_COMMANDS,
  slashCompletion,
  slashText,
} from './slash-commands.ts';

const LOCALES = ['en', 'es', 'pt-BR'];

test('rpg-42a.93 the catalog has every locale and a name and description for every command', () => {
  assert.deepEqual(Object.keys(SLASH_CATALOG), LOCALES);
  assert.deepEqual(missingKeys(SLASH_CATALOG), []);
  for (const { id } of SLASH_COMMANDS) {
    for (const locale of LOCALES) {
      assert.notEqual(slashText(locale, `slash.${id}.name`), `slash.${id}.name`);
      assert.notEqual(slashText(locale, `slash.${id}.description`), `slash.${id}.description`);
    }
  }
});

test('rpg-42a.93 localized names are unique within each locale', () => {
  for (const locale of LOCALES) {
    for (const client of ['desktop', 'tui', 'line'] as const) {
      const names = matchSlash(locale, client, '/').map(({ name }) => name);
      assert.equal(new Set(names).size, names.length);
    }
  }
});

test('rpg-42a.93 a slash prefix filters by client and shows name, description and args hint', () => {
  assert.deepEqual(
    matchSlash('en', 'desktop', '/').map(({ id }) => id),
    ['gm', 'roll'],
  );
  assert.deepEqual(matchSlash('en', 'desktop', '/ro'), [
    { id: 'roll', name: '/roll', description: slashText('en', 'slash.roll.description'), args: '' },
  ]);
  assert.equal(matchSlash('en', 'desktop', '/gm')[0]?.args, slashText('en', 'slash.gm.args'));
  assert.deepEqual(matchSlash('en', 'desktop', 'roll'), []);
  assert.deepEqual(matchSlash('en', 'desktop', '/roll now'), []);
  assert.deepEqual(matchSlash('en', 'desktop', '/zzz'), []);
  assert.deepEqual(
    matchSlash('en', 'tui', '/').map(({ id }) => id),
    ['gm', 'roll', 'retry', 'edit', 'language', 'voice', 'memory', 'help'],
  );
  assert.deepEqual(
    matchSlash('en', 'line', '/').map(({ id }) => id),
    ['roll', 'help', 'history', 'journal', 'sheet', 'sheet-export', 'encounter', 'quit'],
  );
});

test('rpg-42a.93 English names work in every locale next to the localized name', () => {
  assert.equal(matchSlash('pt-BR', 'desktop', '/ro')[0]?.name, '/rolar');
  assert.equal(matchSlash('pt-BR', 'desktop', '/rol')[0]?.id, 'roll');
  assert.deepEqual(resolveSlash('pt-BR', 'desktop', '/roll'), { kind: 'command', id: 'roll', args: '' });
  assert.deepEqual(resolveSlash('pt-BR', 'desktop', '/ROLAR'), { kind: 'command', id: 'roll', args: '' });
  assert.deepEqual(resolveSlash('es', 'line', '/ficha'), { kind: 'command', id: 'sheet', args: '' });
});

test('rpg-42a.93 resolve separates commands, unknown names and plain text', () => {
  assert.deepEqual(resolveSlash('en', 'desktop', '  /gm  you forgot my bonus '), {
    kind: 'command',
    id: 'gm',
    args: 'you forgot my bonus',
  });
  assert.deepEqual(resolveSlash('en', 'desktop', '/x'), { kind: 'unknown', name: '/x' });
  assert.deepEqual(resolveSlash('en', 'desktop', '/sheet'), { kind: 'unknown', name: '/sheet' });
  assert.deepEqual(resolveSlash('en', 'desktop', '/gmail the baron'), { kind: 'unknown', name: '/gmail' });
  assert.deepEqual(resolveSlash('en', 'desktop', 'I open the door'), { kind: 'none' });
  assert.deepEqual(resolveSlash('en', 'desktop', ''), { kind: 'none' });
});

test('rpg-42a.93 completion extends to the shared prefix and lists the matches', () => {
  assert.deepEqual(slashCompletion('en', 'tui', '/ro'), { text: '/roll ', matches: ['/roll'] });
  assert.deepEqual(slashCompletion('en', 'line', '/s'), { text: '/sheet', matches: ['/sheet', '/sheet-export'] });
  assert.deepEqual(slashCompletion('en', 'line', '/sheet'), { text: '/sheet', matches: ['/sheet', '/sheet-export'] });
  assert.deepEqual(slashCompletion('en', 'tui', '/'), {
    text: '/',
    matches: matchSlash('en', 'tui', '/').map(({ name }) => name),
  });
  assert.deepEqual(slashCompletion('en', 'tui', '/zzz'), { text: '/zzz', matches: [] });
  assert.deepEqual(slashCompletion('en', 'tui', 'hello'), { text: 'hello', matches: [] });
});

test('rpg-42a.93 messages are localized with a count plural', () => {
  assert.match(slashText('pt-BR', 'slash.unknown', { name: '/x' }), /\/x/);
  assert.equal(slashText('en', 'slash.options', { count: 1 }), '1 command available');
  assert.equal(slashText('en', 'slash.options', { count: 2 }), '2 commands available');
});
