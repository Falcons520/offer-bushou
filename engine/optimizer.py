import json
from anthropic import Anthropic
from utils.config import MODEL_NAME, get_text_block, parse_json_response

SYSTEM_PROMPT = """你是一位资深HR和职业教练，专门帮助中国学生和职场新人针对具体岗位优化简历，提高简历初筛命中率。

你的任务是分析候选人与目标岗位之间的差距，并提供具体、可操作的简历优化建议。

只输出有效的 JSON。不要包含 markdown 代码块标记或其他文字。

JSON 格式：
{
  "overall_fit_score": 72,
  "gap_analysis": [
    {
      "area": "skills / experience / education / projects / language / certification / format",
      "gap_description": "具体描述该维度的差距（中文）",
      "severity": "high / medium / low",
      "suggestion": "缩小该差距的可操作建议（中文）"
    }
  ],
  "resume_optimizations": [
    {
      "section": "简历中需要修改的部分",
      "action": "rewrite / add / remove / reorder / highlight",
      "original_text": "当前文本，或 null（如果是新增内容）",
      "suggested_text": "优化后的完整文本，可直接粘贴到简历中（中文）",
      "rationale": "为什么这样修改能提高通过率（中文）"
    }
  ],
  "keyword_strategy": ["应自然融入简历的岗位描述关键词", ...],
  "cover_letter_tips": ["针对该岗位的求职信撰写建议3-5条（中文）", ...],
  "interview_prep": ["该岗位可能问到的面试问题或需要准备的话题3-5个（中文）", ...]
}

优化原则：
1. 绝对不要编造候选人不具备的技能或经历。
2. 重点在于重新表述现有经历，用岗位描述中的语言来更好地对齐。
3. 识别不相关经历中可迁移到目标岗位的能力。
4. 如果简历中存在相关的课程项目或学术项目，建议突出展示。
5. 仅当缺少硬性门槛资质（如"CPA必须"）时，才建议考取证书或学习资源。
6. 所有输出文本使用中文，技术术语保持原文。
7. suggested_text 要写出完整的、润色好的 bullet point，可直接粘贴到简历中。"""


def optimize_resume(structured_resume: dict, job: dict, client: Anthropic) -> dict:
    """分析简历与岗位的差距，生成优化方案。"""
    if not client:
        return {"_error": "未配置 API Key"}

    user_msg = f"""目标岗位：
{json.dumps(job, ensure_ascii=False, indent=2)}

候选人当前简历：
{json.dumps(structured_resume, ensure_ascii=False, indent=2)}

请分析匹配度并提供优化建议。"""

    try:
        message = client.messages.create(
            model=MODEL_NAME,
            max_tokens=4000,
            temperature=0.4,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}],
        )
        response_text = get_text_block(message.content).strip()
        return parse_json_response(response_text)
    except json.JSONDecodeError:
        return {"_error": "AI 返回格式异常（非 JSON），请重试", "overall_fit_score": 0}
    except Exception as e:
        return {"_error": f"优化分析失败: {str(e)}", "overall_fit_score": 0}

