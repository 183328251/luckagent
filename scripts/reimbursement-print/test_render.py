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
            'fields': {'所属部门': '测试部门', '报销抬头': '示例公司'}, 'total': '0.30',
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

    def test_reimbursement_title_precedes_applicant(self):
        data = payload()
        renderer.render(self.template, data, self.output)
        with fitz.open(self.output) as doc:
            page = doc[0]
            cells = [page.search_for(text)[0] for text in ['报销抬头：', '示例公司', '申请人', '合成员工']]
            self.assertEqual([cell.x0 for cell in cells], sorted(cell.x0 for cell in cells))
            for cell in cells:
                self.assertAlmostEqual(cell.y0, cells[0].y0, places=2)
        del data['fields']['报销抬头']
        renderer.render(self.template, data, self.output)
        with fitz.open(self.output) as doc:
            self.assertRegex(doc[0].get_text(), r'报销抬头：\s+—\s+申请人')

    def test_content_scales_to_eighty_one_percent_on_a4(self):
        renderer.render(self.template, payload(), self.output)
        with fitz.open(self.output) as doc:
            page = doc[0]
            self.assertAlmostEqual(page.rect.width, 595.276, places=2)
            self.assertAlmostEqual(page.rect.height, 841.89, places=2)
            title_border = page.get_drawings()[0]['rect']
            self.assertAlmostEqual(title_border.width, (page.rect.width - 2 * 12.5 * 72 / 25.4) * .81, places=2)
            self.assertAlmostEqual(title_border.x0, page.rect.width - title_border.x1, places=2)
            title = page.get_text('dict')['blocks'][0]['lines'][0]['spans'][0]
            template_title_size = openpyxl.load_workbook(self.template).worksheets[0]['A1'].font.sz
            self.assertAlmostEqual(title['size'], template_title_size * .81, places=2)

    def test_embeds_only_used_glyphs_of_regular_macos_songti(self):
        songti = Path('/System/Library/Fonts/Supplemental/Songti.ttc')
        if not songti.is_file():
            self.skipTest('macOS Songti font is unavailable')
        renderer.render(self.template, payload(), self.output, songti)
        with fitz.open(self.output) as doc:
            self.assertEqual({font[3].split('+', 1)[-1] for font in doc[0].get_fonts()}, {'Songti SC Regular'})
            self.assertIn('报销金额总计', doc[0].get_text())
        self.assertLess(self.output.stat().st_size, 512 * 1024)

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
            table = doc[0].get_drawings()[0]['rect']
            scale = table.width / sum(widths)
            left = table.x0 + sum(widths[:3]) * scale
            right = left + widths[3] * scale
            description = ''
            for page in doc:
                for block in page.get_text('dict')['blocks']:
                    for line in block.get('lines', []):
                        for span in line['spans']:
                            if span['bbox'][0] >= left and span['bbox'][2] <= right and span['text'] not in {'说明', '申请人'}:
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

    def test_approval_flow_follows_total_and_repeats_its_own_header(self):
        book = openpyxl.load_workbook(self.template)
        book['审批流程']['A1'] = '审批流转记录'
        modified = Path(self.temp.name) / 'custom-approval.xlsx'
        book.save(modified)
        data = payload()
        data['approval_rows'] = [
            {'node': '财务审核', 'person': f'合成审批人{i:02d}', 'action': '同意',
             'time': '2026-11-06 10:20', 'comment': '内部审批意见'}
            for i in range(70)
        ]
        renderer.render(modified, data, self.output)
        with fitz.open(self.output) as doc:
            pages = [page.get_text() for page in doc]
            self.assertGreater(len(pages), 1)
            self.assertLess(pages[0].index('报销金额总计'), pages[0].index('审批流转记录'))
            self.assertIn('合成审批人00 / 同意 / 2026-11-06 10:20', pages[0])
            self.assertIn('合成审批人69', pages[-1])
            self.assertNotIn('内部审批意见', ''.join(pages))
            self.assertNotIn('时间（北京时间）', ''.join(pages))
            borders = [drawing['rect'] for drawing in doc[0].get_drawings()]
            approval_title = next(i for i, rect in enumerate(borders[1:], 1)
                                  if abs(rect.width - borders[0].width) < .01)
            self.assertAlmostEqual(borders[approval_title - 1].y1, borders[approval_title].y0, places=2)
            for text in pages[1:]:
                self.assertIn('审批流转记录', text)
                self.assertNotIn('项目编号', text)
            self.verify_bounds(doc)

    def test_removing_approval_worksheet_hides_approval_data(self):
        book = openpyxl.load_workbook(self.template)
        del book['审批流程']
        modified = Path(self.temp.name) / 'without-approval.xlsx'
        book.save(modified)
        data = payload()
        data['approval_rows'] = [
            {'node': '财务审核', 'person': '合成审批人', 'action': '同意', 'time': '10:20', 'comment': '—'}
        ]
        renderer.render(modified, data, self.output)
        with fitz.open(self.output) as doc:
            self.assertIn('报销金额总计', doc[0].get_text())
            self.assertNotIn('审批记录', doc[0].get_text())
            self.assertNotIn('合成审批人', doc[0].get_text())

    def test_reject_formula(self):
        book = openpyxl.load_workbook(self.template)
        book.active['A2'] = '=HYPERLINK("https://example.invalid","bad")'
        modified = Path(self.temp.name) / 'formula.xlsx'
        book.save(modified)
        with self.assertRaises(ValueError):
            renderer.render(modified, payload(), self.output)


if __name__ == '__main__':
    unittest.main()
