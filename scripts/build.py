#!/usr/bin/env python3
"""Export resolved Lean references, including local bindings, as a static website."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def utf16_slice(text, loc):
    lines = text.split('\n')
    a, b, c, d = loc[:4]
    if a != c:
        return ''
    return lines[a].encode('utf-16-le')[b * 2:d * 2].decode('utf-16-le')


def build(source, output, skip_lean=False):
    source, output = source.resolve(), output.resolve()
    if output == source or source in output.parents or output == ROOT or output in ROOT.parents:
        raise ValueError('Output must be a dedicated directory outside the source repository.')
    paths = sorted(p for p in source.rglob('*.lean') if not any(part.startswith('.') for part in p.relative_to(source).parts))
    if not paths:
        raise ValueError(f'No Lean source files in {source}')
    if not skip_lean:
        subprocess.run(['lake', 'build'], cwd=source, check=True)
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
        files[rel] = dict(path=rel, module=data['module'], text=p.read_text(), imports=[i[0] for i in data['directImports']], symbols=[], refs=[], external=False)
        indexes[rel] = data
    source_hash = hashlib.sha256(''.join(p + f['text'] for p, f in files.items()).encode()).hexdigest()
    toolchain = (source/'lean-toolchain').read_text().strip()
    extractor = ROOT/'scripts/ExportReferences.lean'
    cache_key = hashlib.sha256((source_hash + toolchain + extractor.read_text()).encode()).hexdigest()
    cache = ROOT/'.cache/references'/cache_key
    cache.mkdir(parents=True, exist_ok=True)

    def collect(path):
        target = cache/pathlib.Path(path).with_suffix('.json')
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            result = subprocess.run(['lake', 'env', 'lean', '--run', str(extractor), path, files[path]['module'], str(target)], cwd=source, capture_output=True, text=True)
            if result.returncode:
                target.unlink(missing_ok=True)
                raise ValueError(f'Full reference extraction failed for {path}:\n{result.stdout}\n{result.stderr}')
        return path, json.loads(target.read_text())

    print('Extracting compiler-resolved local bindings (cached by source content)…', flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        for path, result in pool.map(collect, list(files)):
            indexes[path]['references'] = result['references']
            indexes[path]['decls'].update(result['decls'])
    repo_modules = {f['module'] for f in files.values()}
    needed = {}
    for data in indexes.values():
        for imported in data['directImports']:
            if imported[0] not in repo_modules:
                needed.setdefault(imported[0], set())
        for encoded in data['references']:
            ident = json.loads(encoded).get('c')
            if ident and ident['m'] not in repo_modules:
                needed.setdefault(ident['m'], set()).add(ident['n'])
    sysroot = pathlib.Path(subprocess.check_output(['lake', 'env', 'lean', '--print-prefix'], cwd=source, text=True).strip())
    for module, names in sorted(needed.items()):
        relative = pathlib.Path(*module.split('.')).with_suffix('.lean')
        src, index = sysroot/'src/lean'/relative, sysroot/'lib/lean'/relative.with_suffix('.ilean')
        if not src.exists() or not index.exists():
            continue
        data = json.loads(index.read_text())
        if data.get('version') != 5:
            raise ValueError(f'Unsupported library index format for {module}')
        path = 'Library/' + relative.as_posix()
        files[path] = dict(path=path, module=module, text=src.read_text(), imports=[i[0] for i in data['directImports']], symbols=[], refs=[], external=True)
        indexes[path] = data
    modules = {f['module']: p for p, f in files.items()}
    symbols = {}

    def add_symbol(name, module, loc, full=None, local=False, key=None):
        key = key or module + '::' + name
        path = modules[module]
        lines = files[path]['text'].splitlines()
        start = (full or loc)[0]
        context = '\n'.join(lines[start:min(start + 6, len(lines))])
        kind_match = re.search(r'\b(theorem|def|abbrev|inductive|structure|class|instance|opaque|axiom|syntax|macro)\b', context)
        kind = 'local binding' if local else 'generated declaration' if loc[0] != loc[2] else kind_match[1] if full and kind_match else 'field / constructor'
        symbols[key] = dict(id=key, name=name, module=module, file=path, range=loc[:4], span=(full or loc)[:4], kind=kind, local=local,
                            generated=('_aux_' in name or '_private.' in name), callers=[], callees=[], uses=[])
        return key

    def wanted(module, name):
        return module in repo_modules or name in needed.get(module, set())

    for path, data in indexes.items():
        for name, loc in data['decls'].items():
            if wanted(data['module'], name):
                add_symbol(name, data['module'], loc[4:8], loc[:4])
    local_keys = {}
    for path, data in indexes.items():
        for encoded, ref in data['references'].items():
            ident = json.loads(encoded)
            c, f, loc = ident.get('c'), ident.get('f'), ref.get('definition')
            if c and c['m'] in modules and loc and wanted(c['m'], c['n']):
                key = c['m'] + '::' + c['n']
                if key not in symbols:
                    add_symbol(c['n'], c['m'], loc)
            elif f and loc and not files[path]['external']:
                name = utf16_slice(files[path]['text'], loc)
                if not name.strip():
                    continue
                # FVar IDs are ephemeral; source positions keep exported IDs stable.
                key = data['module'] + '::local@' + ':'.join(map(str, loc[:4]))
                local_keys[(path, encoded)] = add_symbol(name, data['module'], loc, local=True, key=key)
    edges = set()
    for path, data in indexes.items():
        seen = set()
        for encoded, ref in data['references'].items():
            ident = json.loads(encoded).get('c')
            key = ident['m'] + '::' + ident['n'] if ident else local_keys.get((path, encoded))
            if key not in symbols:
                continue
            for loc in ref['usages']:
                owner = data['module'] + '::' + loc[4] if len(loc) > 4 else None
                owner = owner if owner in symbols else None
                signature = (*loc[:4], key, owner)
                if signature in seen:
                    continue
                seen.add(signature)
                files[path]['refs'].append([*loc[:4], key, False])
                symbols[key]['uses'].append([path, *loc[:4], owner])
                if owner and not symbols[key]['local']:
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
    data = dict(files=files, symbols=symbols, modules=modules, meta=dict(revision=revision, sourceHash=source_hash,
                toolchain=toolchain, files=len(paths), libraryFiles=len(files)-len(paths), symbols=len(symbols), locals=sum(s['local'] for s in symbols.values()), edges=len(edges),
                references=sum(len(s['uses']) for s in symbols.values())))
    output.mkdir(parents=True, exist_ok=True)
    for asset in (ROOT/'web').iterdir():
        if asset.is_file():
            shutil.copy2(asset, output/asset.name)
    # Library sources load on demand via classic scripts, including when opened via file://.
    (output/'library').mkdir(exist_ok=True)
    for path, f in files.items():
        if f['external']:
            asset = hashlib.sha256(path.encode()).hexdigest()[:16] + '.js'
            text, refs = f.pop('text'), f.pop('refs')
            f['asset'] = 'library/' + asset
            (output/f['asset']).write_text('Object.assign(window.DYLEAN_DATA.files[' + json.dumps(path) + '],' + json.dumps(dict(text=text, refs=refs), ensure_ascii=False, separators=(',', ':')) + ');\n')
    (output/'data.js').write_text('window.DYLEAN_DATA=' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n')
    (output/'build-info.json').write_text(json.dumps(data['meta'], indent=2) + '\n')
    shutil.copy2(source/'LICENSE', output/'SOURCE-LICENSE.txt')
    license_path = sysroot/'LICENSE'
    if license_path.exists():
        shutil.copy2(license_path, output/'LEAN-LICENSE.txt')
    print(f'Exported {len(paths)} repository files + {len(files)-len(paths)} library files, {len(symbols)} symbols ({data["meta"]["locals"]} local bindings), {data["meta"]["references"]} references to {output}')
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=pathlib.Path, default=ROOT.parent/'dylean')
    parser.add_argument('--out', type=pathlib.Path, default=ROOT/'dist')
    parser.add_argument('--skip-lean', action='store_true', help='Reuse up-to-date .ilean files; full local-reference extraction is cached separately')
    args = parser.parse_args()
    try:
        build(args.source, args.out, args.skip_lean)
    except (ValueError, OSError, subprocess.CalledProcessError) as e:
        sys.exit(f'Build failed: {e}')


if __name__ == '__main__':
    main()
