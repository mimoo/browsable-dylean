"""Integration checks against the actual generated Lean reference graph."""
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = json.loads((ROOT/'dist/data.js').read_text().removeprefix('window.DYLEAN_DATA=').removesuffix(';\n'))


def loaded_file(path):
    f = DATA['files'][path]
    if 'text' not in f:
        payload = (ROOT/'dist'/f['asset']).read_text().split('],', 1)[1].removesuffix(');\n')
        f.update(json.loads(payload))
    return f


class IndexTests(unittest.TestCase):
    def test_all_source_files_are_exported_verbatim(self):
        repo = ROOT.parent/'dylean'
        if not repo.exists():
            self.skipTest('Sibling source repository is not available')
        sources = {p.relative_to(repo).as_posix(): p.read_text() for p in repo.rglob('*.lean') if not any(x.startswith('.') for x in p.relative_to(repo).parts)}
        self.assertEqual(sources, {p: f['text'] for p, f in DATA['files'].items() if not f.get('external')})

    def test_every_link_has_a_valid_utf16_destination(self):
        for symbol in DATA['symbols'].values():
            lines = loaded_file(symbol['file'])['text'].split('\n')
            a, b, c, d = symbol['range']
            self.assertTrue(0 <= a <= c < len(lines), symbol['name'])
            self.assertLessEqual(b, len(lines[a].encode('utf-16-le')) // 2, symbol['name'])
            self.assertLessEqual(d, len(lines[c].encode('utf-16-le')) // 2, symbol['name'])
        for path in DATA['files']:
            for ref in loaded_file(path)['refs']:
                self.assertIn(ref[4], DATA['symbols'])

    def test_compiler_resolved_cross_file_reference(self):
        trace = next(s for s in DATA['symbols'].values() if s['name'] == 'DY.Trace')
        self.assertTrue(any(u[0] != trace['file'] for u in trace['uses']))
        lines = DATA['files'][trace['file']]['text'].split('\n')
        a, b, c, d = trace['range']
        self.assertEqual(a, c)
        self.assertEqual(lines[a].encode('utf-16-le')[b*2:d*2].decode('utf-16-le'), 'Trace')

    def test_graph_is_reciprocal_and_supported_by_reference(self):
        for key, s in DATA['symbols'].items():
            for callee in s['callees']:
                self.assertIn(key, DATA['symbols'][callee]['callers'])
                self.assertTrue(any(u[5] == key for u in DATA['symbols'][callee]['uses']))
            for caller in s['callers']:
                self.assertIn(key, DATA['symbols'][caller]['callees'])

    def test_local_bindings_are_distinct_and_have_exact_source_destinations(self):
        locals_ = [s for s in DATA['symbols'].values() if s.get('local')]
        self.assertGreater(len(locals_), 8000)
        trs = [s for s in locals_ if s['name'] == 'tr' and s['file'] == 'DY/Trace/Basic.lean']
        self.assertGreater(len(trs), 5)
        self.assertEqual(len(trs), len({s['id'] for s in trs}))
        for s in locals_:
            a, b, c, d = s['range']
            self.assertEqual(a, c)
            line = DATA['files'][s['file']]['text'].split('\n')[a]
            self.assertEqual(line.encode('utf-16-le')[b*2:d*2].decode('utf-16-le'), s['name'])
            self.assertEqual(s['callers'], [])

    def test_macro_generated_declarations_have_compiler_destinations(self):
        subf = next(s for s in DATA['symbols'].values() if s['name'] == 'DY.Concat.SubF')
        self.assertEqual(subf['file'], 'DY/EquationalTheory/Concat.lean')
        self.assertIn('#combine', DATA['files'][subf['file']]['text'].split('\n')[subf['range'][0]])
        self.assertGreater(len(subf['uses']), 20)
        self.assertEqual(subf['kind'], 'generated declaration')

    def test_nat_resolves_into_bundled_library(self):
        nat = next(s for s in DATA['symbols'].values() if s['name'] == 'Nat')
        self.assertEqual(nat['file'], 'Library/Init/Prelude.lean')
        self.assertTrue(any(u[0] == 'DY/Trace/Basic.lean' for u in nat['uses']))
        f = loaded_file(nat['file'])
        self.assertIn('inductive Nat', f['text'])
        self.assertTrue((ROOT/'dist'/f['asset']).is_file())

    def test_static_entrypoint_and_relative_assets(self):
        html = (ROOT/'dist/index.html').read_text()
        for asset in ['app.js', 'data.js', 'style.css']:
            self.assertIn('"' + asset + '"', html)
            self.assertTrue((ROOT/'dist'/asset).is_file())
        self.assertNotIn('https://', html)
        self.assertIn('width=device-width', html)
        self.assertIn('env(safe-area-inset-bottom)', (ROOT/'dist/style.css').read_text())


if __name__ == '__main__':
    unittest.main()
