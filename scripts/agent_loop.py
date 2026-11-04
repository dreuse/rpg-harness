#!/usr/bin/env python3
"""Conservative single-worker Claude + Beads orchestration scaffold.

Dry-run by default. The script must be explicitly enabled using --execute.
It never bypasses permissions, installs packages, pushes code or runs indefinitely.
The model makes changes; this supervisor independently verifies configured checks.
Read docs/10-roadmap-and-autonomy.md before use.
"""
from __future__ import annotations
import argparse, datetime, json, os, re, shutil, subprocess, sys, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
CATALOG=json.loads((ROOT/'beads/catalog.json').read_text())
TASKS={t['key']:t for t in CATALOG['tasks']}

def command(argv, timeout=120, cwd=ROOT):
    return subprocess.run(argv,cwd=cwd,text=True,capture_output=True,timeout=timeout)

def parse_array(output):
    data=json.loads(output)
    if isinstance(data,list):return data
    if isinstance(data,dict):
        for field in ('issues','items','results','ready'):
            if isinstance(data.get(field),list):return data[field]
    raise ValueError('Unsupported Beads JSON response shape')

def select_ready(allowed):
    r=command(['bd','ready','--json'],timeout=60)
    if r.returncode:raise RuntimeError(r.stderr or r.stdout)
    issues=parse_array(r.stdout)
    choices=[]
    for issue in issues:
        if issue.get('issue_type',issue.get('type','task'))=='epic':continue
        title=issue.get('title','')
        match=re.match(r'^([A-Z]{1,2}\d{2})\s*[—-]',title)
        if not match:continue
        key=match.group(1); t=TASKS.get(key)
        if not t or t['milestone'] not in allowed:continue
        if issue.get('status','open')!='open':continue
        choices.append((t['priority'],CATALOG['topological_order'].index(key),str(issue['id']),t))
    choices.sort()
    return (choices[0][2],choices[0][3]) if choices else None

def execute_checks(commands, timeout, logdir):
    outcomes=[]
    for index,s in enumerate(commands):
        args=s.split() # only simple fixed tokens; no shell or pipe / expansion
        p=command(args,timeout=timeout)
        (logdir/f'check-{index+1:02d}.out').write_text(p.stdout+'\n--- STDERR ---\n'+p.stderr)
        outcomes.append({'command':s,'returncode':p.returncode,'stdout_log':f'check-{index+1:02d}.out'})
        if p.returncode!=0:break
    return outcomes

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--dry-run',action='store_true',help='Show next work without changing anything (default)')
    ap.add_argument('--execute',action='store_true',help='Explicitly run claude and modify current project')
    ap.add_argument('--max-issues',type=int,default=1)
    ap.add_argument('--max-failures',type=int,default=2)
    ap.add_argument('--timeout-seconds',type=int,default=1800)
    ap.add_argument('--check-timeout-seconds',type=int,default=600)
    ap.add_argument('--milestones',default='M1,M2',help='Comma-separated milestone allowlist; M0 design issues should be completed by kickoff review')
    ap.add_argument('--allow-close',action='store_true',help='Allow supervisor to close issue after independently passing configured checks')
    args=ap.parse_args()
    if args.execute and args.dry_run:ap.error('Choose --execute or --dry-run')
    if args.max_issues<1 or args.max_issues>50:ap.error('max-issues must be 1..50')
    if args.max_failures<1 or args.max_failures>20:ap.error('max-failures must be 1..20')
    if args.timeout_seconds<60:ap.error('timeout too low')
    allowed=set(m.strip() for m in args.milestones.split(','))
    if not allowed.issubset({'M0','M1','M2','M3','M4'}):ap.error('invalid milestones')
    if not shutil.which('bd'):print('Missing bd executable');return 2
    if args.execute and not shutil.which('claude'):print('Missing claude executable');return 2
    if args.execute and not (ROOT/'.beads').exists():print('Run Beads initialization and import first');return 2
    failures=0
    logroot=ROOT/'.rpg-agent-runs'
    for i in range(args.max_issues if args.execute else 1):
        nxt=select_ready(allowed)
        if not nxt:
            print('No eligible ready task; inspect bd ready --json and bd dep cycles for blockers.');break
        issue_id, task=nxt
        print(f"NEXT: {task['key']} [{task['milestone']}] {issue_id} — {task['title']}")
        print(f"Goal: {task['acceptance_criteria'][0]}")
        if not args.execute:
            print('DRY RUN. No commands will execute. Use --execute after reviewing implementation permissions.');return 0
        runid=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        logdir=logroot/f"{runid}-{task['key']}";logdir.mkdir(parents=True,exist_ok=True)
        detail=command(['bd','show',issue_id,'--json'],timeout=60)
        (logdir/'issue.json').write_text(detail.stdout or detail.stderr)
        if detail.returncode:print('Could not read issue; stopping');return 2
        claim=command(['bd','update',issue_id,'--claim','--json'],timeout=60)
        if claim.returncode:
            print('Claim failed:',claim.stderr.strip());return 2
        prompt=(f"Implement exactly one Beads issue {issue_id} (planning key {task['key']}). Read CLAUDE.md, the issue from bd show {issue_id}, and relevant docs. "
                f"Perform a cohesive implementation with tests. Never claim/close the issue yourself; an external supervisor runs quality gates and handles status. "
                f"Do not run installers, publish, push, delete user data, or bypass permissions. "
                f"Acceptance criteria: {json.dumps(task['acceptance_criteria'])}. "
                f"At the end, summarize changed files, tests you wrote, actual limits and potential blockers.")
        try:
            model=command(['claude','-p',prompt,'--output-format','text'],timeout=args.timeout_seconds)
        except subprocess.TimeoutExpired:
            (logdir/'model-error.txt').write_text('Claude process timed out')
            print('Timed out; issue remains claimed/in_progress for diagnosis.');failures+=1
            if failures>=args.max_failures:break
            continue
        (logdir/'claude.out').write_text(model.stdout+'\n--- STDERR ---\n'+model.stderr)
        if model.returncode:
            print(f'Claude exited {model.returncode}; issue stays in progress.');failures+=1
            if failures>=args.max_failures:break
            continue
        # Plan/default quality profiles. Never silently skip absent code checks.
        if task['milestone']=='M0':
            checks=['python3 scripts/validate_plan.py']
        else:
            checks=['pnpm typecheck','pnpm lint','pnpm test','pnpm build']
            if not shutil.which('pnpm') or not (ROOT/'package.json').is_file():
                print('Project quality scripts unavailable; leaving issue in progress, not claiming success.')
                failures+=1
                if failures>=args.max_failures:break
                continue
        try:
            results=execute_checks(checks,args.check_timeout_seconds,logdir)
        except (subprocess.TimeoutExpired,FileNotFoundError) as exc:
            results=[{'command':'quality-profile','returncode':1,'error':str(exc)}]
        status={'issue_id':issue_id,'planning_key':task['key'],'tests':results,'model_exit_code':model.returncode,'verified':bool(results) and all(x['returncode']==0 for x in results)}
        (logdir/'verification.json').write_text(json.dumps(status,indent=2)+'\n')
        if status['verified']:
            if args.allow_close:
                comment=command(['bd','comments','add',issue_id,f"Supervisor verified: {', '.join(c['command'] for c in results)}; local evidence .rpg-agent-runs/{logdir.name}/verification.json"],timeout=60)
                closed=command(['bd','close',issue_id,'--reason',f"Automated checks passed; evidence {logdir.name}/verification.json",'--json'],timeout=60)
                if closed.returncode:print('Close failed; investigate',closed.stderr);return 2
                print('Closed verified issue',issue_id)
            else:
                print('Checks passed. Issue deliberately remains in progress; review evidence and enable --allow-close if appropriate.')
                break
        else:
            print('Quality gate failed; issue stays in progress for repair.')
            failures+=1
            if failures>=args.max_failures:break
            # Don't keep claiming unrelated issues while a failed task is in_progress.
            break
    print(f'Run ended; failures={failures}; logs={logroot}')
    return 0 if failures==0 else 1
if __name__=='__main__':raise SystemExit(main())
