from io import BytesIO


def extract_text_from_file(uploaded_file: BytesIO) -> dict:
    """解析上传的 PDF/DOCX 文件，返回 {'success': bool, 'text': str|None, 'error': str|None, 'page_count': int|None}"""
    filename = getattr(uploaded_file, "name", "")
    lower = filename.lower()

    try:
        if lower.endswith(".pdf"):
            return _parse_pdf(uploaded_file)
        elif lower.endswith(".docx"):
            return _parse_docx(uploaded_file)
        else:
            return {"success": False, "text": None, "error": f"不支持的文件格式: {filename}，请上传 PDF 或 DOCX 文件。", "page_count": None}
    except Exception as e:
        return {"success": False, "text": None, "error": f"文件解析失败: {str(e)}", "page_count": None}


def _parse_pdf(file: BytesIO) -> dict:
    from PyPDF2 import PdfReader

    reader = PdfReader(file)
    pages = []
    for page in reader.pages:
        text = page.extract_text()
        if text:
            pages.append(text)

    full_text = "\n".join(pages).strip()

    if len(full_text) < 50:
        return {
            "success": True,
            "text": full_text,
            "page_count": len(reader.pages),
            "error": "⚠️ 提取的文本内容较少，可能是扫描版/图片型PDF，建议上传可编辑文本的PDF文件以确保解析效果。",
        }
    return {"success": True, "text": full_text, "error": None, "page_count": len(reader.pages)}


def _parse_docx(file: BytesIO) -> dict:
    from docx import Document

    doc = Document(file)
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    full_text = "\n".join(paragraphs).strip()

    if len(full_text) < 50:
        return {
            "success": True,
            "text": full_text,
            "error": "⚠️ 提取的文本内容较少，请检查文档内容是否完整。",
            "page_count": None,
        }
    return {"success": True, "text": full_text, "error": None, "page_count": None}
