#!/usr/bin/env python3
"""Import the supplied Beads graph exactly once into an initialized, empty Beads project.

Safe default = preview. Uses the officially documented 'bd create --graph' interface.
"""
import argparse, json, shutil, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
GRAPH=ROOT/'beads/beads-graph.json'

def run(*args, check=True):
    p=subprocess.run(list(args),cwd=ROOT,text=True,capture_output=True)
    if check and p.returncode:
        raise RuntimeError(f"Command failed {args!r}: {p.stderr.strip() or p.stdout.strip()}")
    return p

def main():
    ap=argparse.ArgumentParser(description='Preview or safely import RPG Harness issues into Beads')
    ap.add_argument('--apply',action='store_true',help='Actually create the Beads graph (one time, only in an empty database)')
    args=ap.parse_args()
    if not shutil.which('bd'):
        print('Beads (bd) not installed. Follow https://github.com/gastownhall/beads before importing.');return 2
    chk=run(sys.executable,str(ROOT/'scripts/validate_plan.py'),check=False)
    if chk.returncode:print(chk.stdout+chk.stderr,file=sys.stderr);return 2
    if not (ROOT/'.beads').exists():
        print('No .beads directory. First run git init (if desired) and bd init in this project.');return 2
    version=run('bd','version',check=False)
    print('Beads version:',(version.stdout or version.stderr).strip()[:220])
    helptext=run('bd','create','--help',check=False)
    if '--graph' not in (helptext.stdout+helptext.stderr):
        print('Installed Beads does not advertise bd create --graph. Upgrade or import via its supported command set; do not drop dependencies.');return 2
    listing=run('bd','list','--status','all','--limit','1','--json',check=False)
    # Do not guess that failed queries mean empty DB.
    if listing.returncode:
        print('Cannot confirm Beads DB is empty:',listing.stderr.strip());return 2
    try:
        obj=json.loads(listing.stdout)
        found=obj if isinstance(obj,list) else next((obj.get(k) for k in ('issues','items','results') if isinstance(obj.get(k),list)),None)
        if found is None:raise ValueError('Unexpected bd list JSON shape')
    except Exception as exc:
        print('Cannot safely interpret bd list output:',exc);return 2
    if found:
        print('Refusing import: existing Beads issues found. Do not duplicate graph; use bd show/ready.');return 3
    graph=json.loads(GRAPH.read_text())
    print(f"Graph ready: {len(graph['nodes'])} nodes and {len(graph['edges'])} blocking edges")
    if not args.apply:
        dry=run('bd','create','--graph',str(GRAPH),'--dry-run',check=False)
        print((dry.stdout+dry.stderr).strip()[:2000] or 'No preview output')
        print('DRY RUN ONLY. Pass --apply to actually import.');return 0 if dry.returncode==0 else 2
    print('Importing one time into the current project...')
    result=run('bd','create','--graph',str(GRAPH),'--json',check=False)
    print((result.stdout+result.stderr).strip()[:4000])
    if result.returncode:return result.returncode
    print('Graph import complete. Run bd dep cycles, bd lint and bd ready --json.')
    return 0
if __name__=='__main__':raise SystemExit(main())
