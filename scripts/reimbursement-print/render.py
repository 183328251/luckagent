#!/usr/bin/env python3
"""Render the supported XLSX print template as searchable, embedded-font PDF.

One detail row (identified by {{费用日期}}), repeated for each expense.
The preceding row is the repeating column header. Other placeholders map to
validated scalar approval fields. This is intentionally not a general Excel engine.
"""
import argparse
import json
import os
import re
from pathlib import Path

import openpyxl
import pymupdf as fitz

TOKENS = re.compile(r'\{\{([^{}]+)\}\}')
DETAIL = {'费用日期': 'date', '项目编号': 'project_code', '费用类型': 'expense_type',
          '说明': 'description', '金额': 'amount'}


def render(template, data, output, font_path=None):
    book = openpyxl.load_workbook(template, data_only=False)
    sheet = book.worksheets[0]
    if sheet.max_column > 20 or sheet.max_row > 100 or sheet._images or sheet._charts:
        raise ValueError('模板仅支持不超过20列、100行的文本表格')
    for row in sheet:
        for cell in row:
            if cell.data_type == 'f':
                raise ValueError('模板请使用占位符，不使用Excel公式')
    detail_rows = [row[0].row for row in sheet if any('{{费用日期}}' in str(c.value or '') for c in row)]
    if len(detail_rows) != 1 or detail_rows[0] < 2:
        raise ValueError('模板必须包含唯一的费用明细占位行及其上方的列标题')
    detail_row = detail_rows[0]
    for merge in sheet.merged_cells.ranges:
        if merge.min_row != merge.max_row:
            raise ValueError('不支持跨行合并，请只在同一行合并')
    margin = 12.5 * 72 / 25.4
    page_w, page_h = 595.276, 841.89
    available = page_w - 2 * margin
    widths = [(sheet.column_dimensions[openpyxl.utils.get_column_letter(c)].width or 13) * 7
              for c in range(1, sheet.max_column + 1)]
    widths = [w * available / sum(widths) for w in widths]
    candidates = [font_path, os.environ.get('REIMBURSEMENT_PRINT_FONT'),
                  '/System/Library/Fonts/Supplemental/Songti.ttc',
                  '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc']
    selected_font = next((p for p in candidates if p and Path(p).is_file()), None)
    if not selected_font:
        raise ValueError('需要配置可嵌入的中文字体')
    font = fitz.Font(fontfile=selected_font)
    scalars = {**data.get('fields', {}), '报销月份': data['month'],
               '申请人': data['applicant_name'], '合计金额': data['total'], '币种': data['currency']}

    def substitute(value, expense=None):
        def replacement(match):
            key = match[1]
            if expense is not None and key in DETAIL:
                return str(expense[DETAIL[key]])
            if key not in scalars:
                raise ValueError('模板存在未映射字段')
            return str(scalars[key])
        return TOKENS.sub(replacement, str(value if value is not None else ''))

    def wrap(text, width, size):
        lines = []
        for para in text.split('\n'):
            current = ''
            for char in para:
                if current and font.text_length(current + char, fontsize=size) > width:
                    lines.append(current)
                    current = char
                else:
                    current += char
            lines.append(current)
        return lines or ['']

    def cells_for(row, expense=None):
        cells = []
        col = 1
        while col <= sheet.max_column:
            cell = sheet.cell(row, col)
            merge = next((m for m in sheet.merged_cells.ranges if m.min_row == row and m.min_col == col), None)
            end = merge.max_col if merge else col
            width = sum(widths[col-1:end])
            size = float(cell.font.sz or 10)
            if size < 6 or size > 24:
                raise ValueError('模板字号须在6至24之间')
            cells.append({'width': width, 'size': size, 'align': cell.alignment.horizontal,
                          'lines': wrap(substitute(cell.value, expense), width - 8, size)})
            col = end + 1
        return cells

    doc = fitz.open()
    page = None
    y = margin
    def new_page(repeat=True):
        nonlocal page, y
        page = doc.new_page(width=page_w, height=page_h)
        page.insert_font(fontname='printfont', fontfile=selected_font)
        y = margin
        if repeat:
            draw_row(detail_row - 1, repeat_header=False)

    def draw_row(row, expense=None, repeat_header=True):
        nonlocal y
        cells = cells_for(row, expense)
        line_height = max(c['size'] * 1.3 for c in cells)
        min_height = float(sheet.row_dimensions[row].height or 25)
        lines_left = max(len(c['lines']) for c in cells)
        offset = 0
        while lines_left:
            space = page_h - margin - y
            full_height = max(min_height, lines_left * line_height + 8)
            if full_height > space and y > margin + 30:
                new_page(repeat_header)
                space = page_h - margin - y
            count = min(lines_left, int((space - 8) // line_height))
            if count < 1:
                raise ValueError('模板表头或行高超过一页')
            height = max(min_height if offset == 0 else 0, count * line_height + 8)
            if height > space:
                raise ValueError('模板行高超过一页')
            x = margin
            for cell in cells:
                page.draw_rect(fitz.Rect(x, y, x + cell['width'], y + height), color=(0, 0, 0), width=.55)
                for idx, line in enumerate(cell['lines'][offset:offset+count]):
                    tx = x + 4
                    text_width = font.text_length(line, fontsize=cell['size'])
                    if cell['align'] == 'center':
                        tx = x + (cell['width'] - text_width) / 2
                    elif cell['align'] == 'right':
                        tx = x + cell['width'] - 4 - text_width
                    page.insert_text((tx, y + 4 + cell['size'] + idx * line_height), line,
                                     fontname='printfont', fontsize=cell['size'], color=(0, 0, 0))
                x += cell['width']
            y += height
            offset += count
            lines_left -= count
            if lines_left:
                new_page(repeat_header)

    new_page(False)
    for row in range(1, detail_row):
        draw_row(row, repeat_header=False)
    for expense in data['rows']:
        draw_row(detail_row, expense)
    for row in range(detail_row + 1, sheet.max_row + 1):
        draw_row(row)
    doc.save(output, garbage=4, deflate=True)
    doc.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--template', required=True)
    parser.add_argument('--data', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--font')
    args = parser.parse_args()
    try:
        render(args.template, json.loads(Path(args.data).read_text()), args.output, args.font)
    except Exception:
        # Do not emit approval data, local paths or stack traces into service logs.
        raise SystemExit('PDF template rendering failed')
