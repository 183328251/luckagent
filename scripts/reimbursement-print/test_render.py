"""Synthetic PDF/template verification; no real approvals or employee messages."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
import openpyxl
import pymupdf as fitz

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('print_renderer', Path(__file__).with_name('render.py'))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


def payload():
    return {'month': '2026年11月', 'applicant_name': '合成员工', 'currency': 'CNY',
            'fields': {'所属部门': '测试部门'}, 'total': '0.30',
            'rows': [{'date': '2026-11-06', 'project_code': 'P-DEMO', 'expense_type': '测试',
                      'description': '合成说明', 'amount': '0.30'}]}


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / 'test.pdf'
        self.template = ROOT / 'assets/reimbursement-print/template.xlsx'

    def verify_bounds(self, doc):
        for page in doc:
            self.assertTrue(any(font[1] for font in page.get_fonts()))
            for block in page.get_text('dict')['blocks']:
                if 'lines' not in block:
                    continue
                for line in block['lines']:
                    for span in line['spans']:
                        box = fitz.Rect(span['bbox'])
                        self.assertGreaterEqual(box.x0, 30)
                        self.assertLessEqual(box.x1, page.rect.width - 30)
                        self.assertGreaterEqual(box.y0, 30)
                        self.assertLessEqual(box.y1, page.rect.height - 30)

    def test_baseline_searchable_pdf(self):
        renderer.render(self.template, payload(), self.output)
        with fitz.open(self.output) as doc:
            self.assertEqual(len(doc), 1)
            text = doc[0].get_text()
            for value in ['2026年11月', '合成员工', 'P-DEMO', '2026-11-06', '0.30', '报销金额总计']:
                self.assertIn(value, text)
            self.assertNotIn('{{', text)
            self.verify_bounds(doc)

    def test_many_rows_repeat_headers_total_only_on_last_page(self):
        data = payload()
        data['rows'] = [dict(data['rows'][0], description=f'合成费用第{i:03d}笔') for i in range(80)]
        renderer.render(self.template, data, self.output)
        with fitz.open(self.output) as doc:
            self.assertGreater(len(doc), 2)
            texts = [p.get_text() for p in doc]
            for text in texts:
                self.assertIn('日期', text)
                self.assertIn('项目编号', text)
            self.assertEqual(''.join(texts).count('报销金额总计'), 1)
            self.assertIn('报销金额总计', texts[-1])
            for i in range(80):
                self.assertIn(f'合成费用第{i:03d}笔', ''.join(texts))
            self.verify_bounds(doc)

    def test_extremely_long_single_description_spans_pages(self):
        data = payload()
        data['rows'][0]['description'] = '长说明内容' * 700 + '末尾校验字符'
        renderer.render(self.template, data, self.output)
        with fitz.open(self.output) as doc:
            self.assertGreater(len(doc), 2)
            text = ''.join(p.get_text() for p in doc).replace('\n', '')
            self.assertIn('末尾校验字符', text)
            book = openpyxl.load_workbook(self.template)
            widths = [(book.active.column_dimensions[openpyxl.utils.get_column_letter(c)].width or 13) * 7 for c in range(1, 6)]
            scale = (595.276 - 2 * 35.433070866) / sum(widths)
            left = 35.433070866 + sum(widths[:3]) * scale
            right = left + widths[3] * scale
            description = ''
            for page in doc:
                for block in page.get_text('dict')['blocks']:
                    for line in block.get('lines', []):
                        for span in line['spans']:
                            if span['bbox'][0] >= left and span['bbox'][2] <= right and span['text'] != '说明':
                                description += span['text']
            self.assertEqual(description, data['rows'][0]['description'])
            self.verify_bounds(doc)

    def test_added_known_scalar_and_unknown_token(self):
        book = openpyxl.load_workbook(self.template)
        book.active['A2'] = '{{所属部门}}'
        modified = Path(self.temp.name) / 'modified.xlsx'
        book.save(modified)
        renderer.render(modified, payload(), self.output)
        with fitz.open(self.output) as doc:
            self.assertIn('测试部门', doc[0].get_text())
        book.active['A2'] = '{{尚未映射的字段}}'
        book.save(modified)
        with self.assertRaises(ValueError):
            renderer.render(modified, payload(), self.output)

    def test_reject_formula(self):
        book = openpyxl.load_workbook(self.template)
        book.active['A2'] = '=HYPERLINK("https://example.invalid","bad")'
        modified = Path(self.temp.name) / 'formula.xlsx'
        book.save(modified)
        with self.assertRaises(ValueError):
            renderer.render(modified, payload(), self.output)


if __name__ == '__main__':
    unittest.main()
