import json
from anthropic import Anthropic
from utils.config import MODEL_NAME, get_text_block, parse_json_response

SYSTEM_PROMPT = """你是一个精确的简历解析引擎。你的任务是从原始简历文本中提取结构化信息。

只输出有效的 JSON。不要包含 markdown 代码块标记、解释或 JSON 之外的任何文字。

JSON 必须包含以下键：
- "name": 姓名（字符串，未知则为 null）
- "email": 邮箱（字符串，未知则为 null）
- "phone": 电话（字符串，未知则为 null）
- "skills": 技能列表（字符串数组），技术技能和软技能都包含
- "experience": 工作/实习经历列表，每项包含：
  - "title": 职位名称（字符串）
  - "company": 公司/组织名称（字符串）
  - "duration": 时间范围（字符串，如 "2024.06-2025.03" 或 "2023.09-至今"）
  - "highlights": 关键职责/成就（字符串数组）
- "education": 教育经历列表，每项包含：
  - "degree": 学位（字符串）
  - "school": 学校（字符串）
  - "major": 专业（字符串）
  - "year": 毕业年份（字符串或 null）
- "projects": 项目经历列表，每项包含：
  - "name": 项目名称（字符串）
  - "description": 项目描述（字符串）
  - "technologies": 使用的技术/工具（字符串数组）
- "languages": 语言能力列表（字符串数组，如 "英语（CET-6 580）"、"普通话（母语）"）
- "certifications": 证书/资质列表（字符串数组）

规则：
1. 若简历中未提及某项信息，单值字段返回 null，数组字段返回空列表 []。
2. 标准化技能名称（如 "Python3" → "Python"、"React.js" → "React"）。
3. 从日期范围中推断时间区间。若某段经历无结束日期，标记为"至今"。
4. 仅提取简历文本中明确出现的信息，不要编造或推测缺失的信息。
5. 所有字符串使用简历的原始语言输出。"""

EXTRACTION_RETRY_PROMPT = "你上次的回复不是有效的 JSON。请仅输出 JSON 对象，不要包含任何其他文字。"


def extract_resume(resume_text: str, client: Anthropic) -> dict:
    """调用 Claude 提取结构化简历信息。失败时重试一次，重试时强调 JSON 格式要求。"""
    if not client:
        return _empty_result("未配置 API Key")

    for attempt in range(2):
        prefix = ""
        if attempt == 1:
            prefix = EXTRACTION_RETRY_PROMPT + "\n\n---\n\n"

        try:
            message = client.messages.create(
                model=MODEL_NAME,
                max_tokens=2000,
                temperature=0.1,
                system=SYSTEM_PROMPT,
                messages=[
                    {
                        "role": "user",
                        "content": f"{prefix}请从以下简历文本中提取结构化信息：\n\n---\n{resume_text}\n---",
                    }
                ],
            )
            response_text = get_text_block(message.content).strip()
            data = parse_json_response(response_text)
            return {
                "name": data.get("name", None),
                "email": data.get("email", None),
                "phone": data.get("phone", None),
                "skills": data.get("skills", []),
                "experience": data.get("experience", []),
                "education": data.get("education", []),
                "projects": data.get("projects", []),
                "languages": data.get("languages", []),
                "certifications": data.get("certifications", []),
            }
        except json.JSONDecodeError:
            if attempt == 0:
                continue
            return _empty_result("AI 解析结果格式异常，请重试")
        except Exception as e:
            if attempt == 0:
                continue
            return _empty_result(f"简历解析失败: {str(e)}")

    return _empty_result("简历解析重试失败，请稍后再试")




def _empty_result(error_msg: str) -> dict:
    return {
        "name": None, "email": None, "phone": None,
        "skills": [], "experience": [], "education": [],
        "projects": [], "languages": [], "certifications": [],
        "_error": error_msg,
    }
