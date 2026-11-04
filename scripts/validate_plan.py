#!/usr/bin/env python3
"""Offline structural/semantic validation of RPG Harness planning package.

Does NOT require Beads installation. Validates the supplied graph before import.
"""
from __future__ import annotations
import json, re, collections, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BEADS=ROOT/'beads'

def fail(errors, msg): errors.append(msg)

def validate():
    catalog=json.loads((BEADS/'catalog.json').read_text())
    graph=json.loads((BEADS/'beads-graph.json').read_text())
    errors=[]
    epics=catalog['epics']; tasks=catalog['tasks']; nodes=graph['nodes']; edges=graph['edges']
    keys=[t['key'] for t in tasks]
    if len(set(keys))!=len(keys):fail(errors,'Duplicate task planning keys')
    bykey={t['key']:t for t in tasks}
    nodekeys=[n.get('key') for n in nodes]
    if len(set(nodekeys))!=len(nodekeys):fail(errors,'Duplicate graph node keys')
    if set(nodekeys)!=set(keys)|set(epics):fail(errors,'Graph nodes do not match catalog task + epic keys')
    if len(nodes)!=len(tasks)+len(epics):fail(errors,'Wrong graph node count')
    if set(catalog['topological_order']) != set(keys):fail(errors,'Topological order is incomplete')
    edge_pairs={(e.get('from_key'),e.get('to_key')) for e in edges}
    if len(edge_pairs)!=len(edges):fail(errors,'Duplicate blocking edges')
    for e in edges:
        if e.get('type')!='blocks':fail(errors,'Unexpected edge type')
        if e.get('from_key') not in bykey or e.get('to_key') not in bykey:fail(errors, f"Unknown edge endpoint {e}")
    for t in tasks:
        k=t['key']; deps=t['dependencies']
        if not re.fullmatch(r'[A-Z]{1,2}\d{2}',k):fail(errors,f'{k}: invalid logical key')
        if t.get('epic') not in epics:fail(errors,f'{k}: missing epic')
        if t.get('milestone') not in ('M0','M1','M2','M3','M4'):fail(errors,f'{k}: missing milestone')
        if t.get('priority') not in (0,1,2,3,4):fail(errors,f'{k}: bad priority')
        if not t.get('description') or not t.get('design') or not t.get('validation'):fail(errors,f'{k}: incomplete spec')
        if len(t.get('acceptance_criteria',[]))<3:fail(errors,f'{k}: fewer than 3 acceptance criteria')
        if any(len(a)<18 for a in t.get('acceptance_criteria',[])):fail(errors,f'{k}: short acceptance criterion')
        if set(deps)-set(keys):fail(errors,f'{k}: missing deps {set(deps)-set(keys)}')
        if set(deps)!={b for a,b in edge_pairs if a==k}:fail(errors,f'{k}: graph dependency mismatch')
        node=next((n for n in nodes if n.get('key')==k),None)
        if not node: continue
        if node.get('parent_key')!=t['epic']:fail(errors,f'{k}: graph parent mismatch')
        if node.get('priority')!=t['priority']:fail(errors,f'{k}: graph priority mismatch')
        if 'Acceptance' not in node.get('description','') and 'acceptance_criteria' not in node:fail(errors,f'{k}: missing acceptance')
        if (node.get('metadata') or {}).get('plan_key')!=k:fail(errors,f'{k}: metadata planning key missing')
        if len(node.get('labels',[]))<2:fail(errors,f'{k}: missing labels')
    m_order={'M0':0,'M1':1,'M2':2,'M3':3,'M4':4}
    for t in tasks:
        for dep in t['dependencies']:
            if dep in bykey and m_order[bykey[dep]['milestone']]>m_order[t['milestone']]:
                fail(errors,f"{t['key']}: depends on later milestone task {dep}")
    visiting=set(); seen=set(); order=[]
    def walk(k):
        if k in visiting:fail(errors,f'Cycle involving {k}');return
        if k in seen:return
        visiting.add(k)
        for dep in bykey[k]['dependencies']:
            if dep in bykey:walk(dep)
        visiting.remove(k);seen.add(k);order.append(k)
    for k in keys:walk(k)
    if catalog['topological_order']!=order:fail(errors,'Stored topological ordering does not match current graph')
    required=['README.md','PROMPT_CLAUDE_CODE.md','CLAUDE.md','docs/01-product-contract.md','docs/02-architecture.md','docs/03-rules-and-ingestion.md','docs/04-character-sheets.md','docs/05-living-world.md','docs/06-conversational-intent.md','docs/07-clients-voice.md','docs/08-storage-and-events.md','docs/09-quality-and-testing.md','docs/10-roadmap-and-autonomy.md','docs/11-security-and-content.md','docs/12-contract-examples.md','scripts/bootstrap_beads.py','scripts/agent_loop.py']
    for path in required:
        if not (ROOT/path).is_file():fail(errors,f'Missing file: {path}')
    counts=collections.Counter(t['milestone'] for t in tasks)
    print(f"Plan: {len(epics)} epics, {len(tasks)} tasks, {len(edges)} blocking edges, milestones {dict(sorted(counts.items()))}")
    if errors:
        for err in errors:print('ERROR:',err,file=sys.stderr)
        return 1
    print('PASS: unique keys, graph/catalog parity, acceptance criteria, dependencies, cycles, milestone direction and required files')
    print('NOTE: Beads CLI graph import was not executed by this offline validator.')
    return 0
if __name__=='__main__':raise SystemExit(validate())
