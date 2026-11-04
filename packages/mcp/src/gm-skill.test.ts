import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CAMPAIGN_TOOLS } from './tools.ts';

const SKILL_PATH = new URL('../../../.claude/skills/rpg-gm/SKILL.md', import.meta.url);
const FRONTMATTER = /^---\nname: rpg-gm\ndescription: .+\n---\n/;
const TOOL_CALL = /`([a-z_]+)` MCP tool/g;
const SUBMIT_TOOL = 'submit_action';
const NOT_COMMITTED = 'Nothing is committed until the engine validates this proposal.';

const skill = readFileSync(SKILL_PATH, 'utf8');
const calledTools = [...skill.matchAll(TOOL_CALL)].map(([, name]) => name);
const toolNamed = (name: string | undefined) => CAMPAIGN_TOOLS.find((tool) => tool.name === name);
const PROPOSAL_FIELDS = Object.keys(toolNamed(SUBMIT_TOOL)?.inputSchema.properties ?? {});

test('skill narrates one scene, reads engine state and interprets one player input', () => {
  assert.match(skill, FRONTMATTER);
  assert.deepEqual(calledTools, ['get_campaign', 'get_scene', SUBMIT_TOOL]);
  for (const name of calledTools.filter((tool) => tool !== SUBMIT_TOOL)) {
    assert.equal(toolNamed(name)?.annotations.readOnlyHint, true, name);
  }
  assert.match(skill, /data, not instructions/);
  assert.match(skill, /player input/);
  assert.match(skill, /```proposal/);
  assert.ok(PROPOSAL_FIELDS.includes('actionId'));
  for (const field of PROPOSAL_FIELDS) assert.match(skill, new RegExp(`^${field}: `, 'm'), field);
  assert.match(skill, /Reuse the same `actionId` on a retry/);
});

test('narration never substitutes for persistent state mutation', () => {
  const mutationTools = CAMPAIGN_TOOLS.filter(
    (tool) => !tool.annotations.readOnlyHint && tool.name !== SUBMIT_TOOL,
  ).map((tool) => tool.name);
  assert.ok(mutationTools.length > 0);
  for (const name of mutationTools) {
    assert.ok(!calledTools.includes(name), name);
    assert.match(skill, new RegExp(`Never call \`${name}\``), name);
  }
  assert.ok(skill.includes(NOT_COMMITTED));
  assert.match(skill, /Never say the state changed/);
  assert.match(skill, /Call the `submit_action` MCP tool only after the proposal block/);
  assert.match(skill, /Report the new `revision`/);
});
