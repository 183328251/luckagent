#!/usr/bin/env python3
"""Render the supported XLSX print template as searchable, embedded-font PDF.

One detail row (identified by {{费用日期}}), repeated for each expense.
The preceding row is the repeating column header. Other placeholders map to
validated scalar approval fields. The optional 审批流程 worksheet styles the approval section.
"""
import argparse
from io import BytesIO
import json
import os
import re
from pathlib import Path

import openpyxl
import pymupdf as fitz
from fontTools.ttLib import TTCollection

TOKENS = re.compile(r'\{\{([^{}]+)\}\}')
DETAIL = {'费用日期': 'date', '项目编号': 'project_code', '费用类型': 'expense_type',
          '说明': 'description', '金额': 'amount'}
APPROVAL = {'审批节点': 'node', '审批处理人': 'person', '审批状态': 'action',
            '审批时间': 'time', '审批意见': 'comment'}
APPROVAL_SHEET = '审批流程'
APPROVAL_CATEGORY = '审批类别'
APPROVAL_CATEGORIES = {'发起申请': '发起', '抄送': '抄送'}
CONTENT_SCALE = 0.81


def load_print_font(path):
    if Path(path).suffix.lower() not in {'.ttc', '.otc'}:
        return fitz.Font(fontfile=path)

    # MuPDF otherwise uses the first face, which is Black in macOS Songti.ttc.
    collection = TTCollection(path, lazy=True)
    try:
        def face_preference(face):
            name = face['name'].getDebugName(4) or ''
            return abs(face['OS/2'].usWeightClass - 400), 'SC' not in name.split()

        face = min(collection.fonts, key=face_preference)
        buffer = BytesIO()
        face.save(buffer)
        return fitz.Font(fontbuffer=buffer.getvalue())
    finally:
        collection.close()


def validate_sheet(sheet):
    if sheet.max_column > 20 or sheet.max_row > 100 or sheet._images or sheet._charts:
        raise ValueError('模板仅支持不超过20列、100行的文本表格')
    for row in sheet:
        for cell in row:
            if cell.data_type == 'f':
                raise ValueError('模板请使用占位符，不使用Excel公式')
    for merge in sheet.merged_cells.ranges:
        if merge.min_row != merge.max_row:
            raise ValueError('不支持跨行合并，请只在同一行合并')


def render(template, data, output, font_path=None):
    book = openpyxl.load_workbook(template, data_only=False)
    sheet = book.worksheets[0]
    validate_sheet(sheet)
    detail_rows = [row[0].row for row in sheet if any('{{费用日期}}' in str(c.value or '') for c in row)]
    if len(detail_rows) != 1 or detail_rows[0] < 2:
        raise ValueError('模板必须包含唯一的费用明细占位行及其上方的列标题')
    detail_row = detail_rows[0]
    margin = 12.5 * 72 / 25.4
    page_w, page_h = 595.276, 841.89
    available = page_w - 2 * margin
    # Scale about the horizontal center and the top margin of the A4 page.
    placement = fitz.Matrix(CONTENT_SCALE, 0, 0, CONTENT_SCALE,
                            page_w / 2 * (1 - CONTENT_SCALE), margin * (1 - CONTENT_SCALE))
    content_height = (page_h - 2 * margin) / CONTENT_SCALE
    content_bottom = margin + content_height

    def column_widths(worksheet):
        widths = [worksheet.column_dimensions[openpyxl.utils.get_column_letter(c)].width or 13
                  for c in range(1, worksheet.max_column + 1)]
        total_width = sum(widths)
        return [w * available / total_width for w in widths]

    widths = column_widths(sheet)
    candidates = [font_path, os.environ.get('REIMBURSEMENT_PRINT_FONT'),
                  '/System/Library/Fonts/Supplemental/Songti.ttc',
                  '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc']
    selected_font = next((p for p in candidates if p and Path(p).is_file()), None)
    if not selected_font:
        raise ValueError('需要配置可嵌入的中文字体')
    font = load_print_font(selected_font)
    font_buffer = font.buffer
    scalars = {**data.get('fields', {}), '报销月份': data['month'],
               '申请人': data['applicant_name'], '合计金额': data['total'], '币种': data['currency']}
    scalars['报销抬头'] = scalars.get('报销抬头') or '—'

    def substitute(value, row_values):
        def replacement(match):
            key = match[1]
            if key in row_values:
                return str(row_values[key])
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

    def cells_for(worksheet, row, widths, row_values):
        cells = []
        col = 1
        while col <= worksheet.max_column:
            cell = worksheet.cell(row, col)
            merge = next((m for m in worksheet.merged_cells.ranges if m.min_row == row and m.min_col == col), None)
            end = merge.max_col if merge else col
            width = sum(widths[col-1:end])
            size = float(cell.font.sz or 10)
            if size < 6 or size > 24:
                raise ValueError('模板字号须在6至24之间')
            cells.append({'width': width, 'size': size, 'align': cell.alignment.horizontal,
                          'lines': wrap(substitute(cell.value, row_values), width - 8, size)})
            col = end + 1
        return cells

    doc = fitz.open()
    page = None
    y = margin
    def new_page(header=None):
        nonlocal page, y
        page = doc.new_page(width=page_w, height=page_h)
        page.insert_font(fontname='printfont', fontbuffer=font_buffer)
        y = margin
        if header:
            header()

    def draw_cells(cells, min_height, header=None, split_on_current_page=False):
        nonlocal y
        line_height = max(c['size'] * 1.3 for c in cells)
        lines_left = max(len(c['lines']) for c in cells)
        offset = 0
        while lines_left:
            space = content_bottom - y
            full_height = max(min_height, lines_left * line_height + 8)
            required_height = max(min_height, line_height + 8) if split_on_current_page else full_height
            if required_height > space and y > margin + 30:
                new_page(header)
                space = content_bottom - y
            count = min(lines_left, int((space - 8) // line_height))
            if count < 1:
                raise ValueError('模板表头或行高超过一页')
            height = max(min_height if offset == 0 else 0, count * line_height + 8)
            if height > space:
                raise ValueError('模板行高超过一页')
            x = margin
            for cell in cells:
                rect = fitz.Rect(x, y, x + cell['width'], y + height) * placement
                page.draw_rect(rect, color=(0, 0, 0), width=.55 * CONTENT_SCALE)
                for idx, line in enumerate(cell['lines'][offset:offset+count]):
                    tx = x + 4
                    text_width = font.text_length(line, fontsize=cell['size'])
                    if cell['align'] == 'center':
                        tx = x + (cell['width'] - text_width) / 2
                    elif cell['align'] == 'right':
                        tx = x + cell['width'] - 4 - text_width
                    origin = fitz.Point(tx, y + 4 + cell['size'] + idx * line_height) * placement
                    page.insert_text(origin, line, fontname='printfont',
                                     fontsize=cell['size'] * CONTENT_SCALE, color=(0, 0, 0))
                x += cell['width']
            y += height
            offset += count
            lines_left -= count
            if lines_left:
                new_page(header)

    def draw_row(row, expense=None, header=None):
        height = float(sheet.row_dimensions[row].height or 25)
        values = {token: expense[key] for token, key in DETAIL.items()} if expense is not None else {}
        draw_cells(cells_for(sheet, row, widths, values), height, header)

    def expense_header():
        draw_row(detail_row - 1)

    def draw_approval_section(worksheet, entries):
        validate_sheet(worksheet)
        approval_tokens = {*APPROVAL, APPROVAL_CATEGORY}
        detail_rows = [
            row[0].row for row in worksheet
            if any(approval_tokens.intersection(TOKENS.findall(str(cell.value or ''))) for cell in row)
        ]
        if len(detail_rows) != 1:
            raise ValueError('审批流程工作表须包含唯一的审批明细占位行')
        approval_detail_row = detail_rows[0]
        approval_widths = column_widths(worksheet)
        headers = [
            (cells_for(worksheet, row, approval_widths, {}), float(worksheet.row_dimensions[row].height or 25))
            for row in range(1, approval_detail_row)
        ]
        detail_height = float(worksheet.row_dimensions[approval_detail_row].height or 25)

        def approval_header():
            for cells, height in headers:
                draw_cells(cells, height)

        def row_height(cells, minimum):
            return max(minimum, max(len(cell['lines']) for cell in cells) *
                       max(cell['size'] * 1.3 for cell in cells) + 8)

        detail_cells = cells_for(worksheet, approval_detail_row, approval_widths, dict.fromkeys(approval_tokens, ''))
        detail_line_height = max(cell['size'] * 1.3 for cell in detail_cells)
        section_height = sum(row_height(cells, height) for cells, height in headers)
        section_height += max(detail_height, detail_line_height + 8)
        if section_height > content_height:
            raise ValueError('审批流程表头或行高超过一页')
        if content_bottom - y < section_height:
            new_page()
        approval_header()
        for entry in entries:
            values = {token: entry[key] for token, key in APPROVAL.items()}
            values[APPROVAL_CATEGORY] = APPROVAL_CATEGORIES.get(entry['action'], '审批')
            cells = cells_for(worksheet, approval_detail_row, approval_widths, values)
            draw_cells(cells, detail_height, approval_header, split_on_current_page=True)

    new_page()
    for row in range(1, detail_row):
        draw_row(row)
    for expense in data['rows']:
        draw_row(detail_row, expense, expense_header)
    for row in range(detail_row + 1, sheet.max_row + 1):
        draw_row(row, header=expense_header)
    approval_rows = data.get('approval_rows', [])
    if APPROVAL_SHEET in book and approval_rows:
        draw_approval_section(book[APPROVAL_SHEET], approval_rows)
    doc.subset_fonts()
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
