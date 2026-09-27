#!/usr/bin/env python3
"""Export Lean's resolved .ilean references as a standalone static code browser."""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def build(source, output, skip_lean=False):
    source, output = source.resolve(), output.resolve()
    if output == source or source in output.parents or output == ROOT or output in ROOT.parents:
        raise ValueError('Output must be a dedicated directory outside the source repository.')
    paths = sorted(p for p in source.rglob('*.lean') if not any(part.startswith('.') for part in p.relative_to(source).parts))
    if not paths:
        raise ValueError(f'No Lean source files in {source}')
    if not skip_lean:
        subprocess.run(['lake', 'build'], cwd=source, check=True)
        # Explicit module targets include source files outside defaultTargets' import closure.
        subprocess.run(['lake', 'build', *['+' + str(p.relative_to(source).with_suffix('')).replace('/', '.') + ':ilean' for p in paths]], cwd=source, check=True)
    files, indexes = {}, {}
    for p in paths:
        rel = p.relative_to(source).as_posix()
        index = source / '.lake/build/lib/lean' / pathlib.Path(rel).with_suffix('.ilean')
        if not index.exists() or (skip_lean and index.stat().st_mtime_ns < p.stat().st_mtime_ns):
            raise ValueError(f'Missing or stale index for {rel}; run the normal build without --skip-lean.')
        data = json.loads(index.read_text())
        if data['version'] != 5:
            raise ValueError(f'Unsupported .ilean version {data["version"]}; expected 5')
        text = p.read_text()
        files[rel] = dict(path=rel, module=data['module'], text=text, imports=[i[0] for i in data['directImports']], symbols=[], refs=[])
        indexes[rel] = data
    modules = {f['module']: p for p, f in files.items()}
    symbols = {}

    def add_symbol(name, module, loc, full=None):
        key = module + '::' + name
        path = modules[module]
        lines = files[path]['text'].splitlines()
        start = (full or loc)[0]
        context = '\n'.join(lines[start:min(start + 6, len(lines))])
        kind_match = re.search(r'\b(theorem|def|abbrev|inductive|structure|class|instance|opaque|axiom|syntax|macro)\b', context)
        kind = kind_match[1] if full and kind_match else 'field / constructor'
        symbols[key] = dict(id=key, name=name, module=module, file=path, range=loc[:4], span=(full or loc)[:4], kind=kind,
                            generated=('_aux_' in name or '_private.' in name), callers=[], callees=[], uses=[])
        return key

    for path, data in indexes.items():
        for name, loc in data['decls'].items():
            add_symbol(name, data['module'], loc[4:8], loc[:4])
    # Constructors and structure fields can have definition records without a decls entry.
    for path, data in indexes.items():
        for encoded, ref in data['references'].items():
            ident = json.loads(encoded).get('c')
            if ident and ident['m'] in modules and ref.get('definition'):
                key = ident['m'] + '::' + ident['n']
                if key not in symbols:
                    add_symbol(ident['n'], ident['m'], ref['definition'])
    edges = set()
    for path, data in indexes.items():
        seen = set()
        for encoded, ref in data['references'].items():
            ident = json.loads(encoded).get('c')
            if not ident:
                continue
            key = ident['m'] + '::' + ident['n']
            if key not in symbols:
                continue  # External toolchain symbols have no bundled definition.
            for loc in ref['usages']:
                owner = data['module'] + '::' + loc[4] if len(loc) > 4 else None
                owner = owner if owner in symbols else None
                signature = (*loc[:4], key, owner)
                if signature in seen:
                    continue
                seen.add(signature)
                files[path]['refs'].append([*loc[:4], key, False])
                symbols[key]['uses'].append([path, *loc[:4], owner])
                if owner:
                    edges.add((owner, key))
        for key, symbol in symbols.items():
            if symbol['file'] == path:
                files[path]['symbols'].append(key)
                if not symbol['generated'] and symbol['range'][0] == symbol['range'][2]:
                    files[path]['refs'].append([*symbol['range'], key, True])
        files[path]['symbols'].sort(key=lambda k: symbols[k]['range'])
        files[path]['refs'].sort(key=lambda r: (r[0], r[1], r[2], r[3], r[4]))
    for caller, callee in sorted(edges):
        symbols[caller]['callees'].append(callee)
        symbols[callee]['callers'].append(caller)
    # Stable compact identifiers keep repeated graph edges small on mobile connections.
    ids = {key: hashlib.sha256(key.encode()).hexdigest()[:12] for key in symbols}
    if len(set(ids.values())) != len(ids):
        raise ValueError('Symbol ID collision')
    for f in files.values():
        f['symbols'] = [ids[k] for k in f['symbols']]
        for ref in f['refs']:
            ref[4] = ids[ref[4]]
    for key, symbol in symbols.items():
        symbol['id'] = ids[key]
        for edge in ('callers', 'callees'):
            symbol[edge] = [ids[k] for k in symbol[edge]]
        for use in symbol['uses']:
            use[5] = ids[use[5]] if use[5] else None
    symbols = {ids[k]: s for k, s in symbols.items()}
    revision = subprocess.run(['git', '-C', str(source), 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()
    digest = hashlib.sha256(''.join(p + f['text'] for p, f in files.items()).encode()).hexdigest()
    data = dict(files=files, symbols=symbols, modules=modules, meta=dict(revision=revision, sourceHash=digest,
                toolchain=(source/'lean-toolchain').read_text().strip(), files=len(files), symbols=len(symbols), edges=len(edges),
                references=sum(len(s['uses']) for s in symbols.values())))
    output.mkdir(parents=True, exist_ok=True)
    for asset in (ROOT/'web').iterdir():
        if asset.is_file():
            shutil.copy2(asset, output/asset.name)
    # Classic script works over both file:// and arbitrary static-host subpaths; no API or fetch.
    (output/'data.js').write_text('window.DYLEAN_DATA=' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n')
    (output/'build-info.json').write_text(json.dumps(data['meta'], indent=2) + '\n')
    shutil.copy2(source/'LICENSE', output/'SOURCE-LICENSE.txt')
    print(f'Exported {len(files)} files, {len(symbols)} symbols, {len(edges)} caller edges to {output}')
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=pathlib.Path, default=ROOT.parent/'dylean')
    parser.add_argument('--out', type=pathlib.Path, default=ROOT/'dist')
    parser.add_argument('--skip-lean', action='store_true', help='Use existing, up-to-date .ilean files (fails on stale/missing indexes)')
    args = parser.parse_args()
    try:
        build(args.source, args.out, args.skip_lean)
    except (ValueError, OSError, subprocess.CalledProcessError) as e:
        sys.exit(f'Build failed: {e}')


if __name__ == '__main__':
    main()
