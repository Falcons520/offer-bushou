import json
from anthropic import Anthropic
from utils.config import MODEL_NAME, MAX_JOBS_PER_BATCH, DEFAULT_TOP_K, get_text_block, parse_json_response

SYSTEM_PROMPT = """你是一位资深职业顾问和求职匹配专家，专注于中国市场。你的任务是将候选人的结构化简历与岗位列表进行匹配，返回最佳匹配结果。

只输出有效的 JSON。不要包含 markdown 代码块标记或解释性文字。

JSON 格式：
{
  "matches": [
    {
      "job_id": "岗位ID",
      "match_score": 8,
      "match_summary": "1-2句话中文说明为什么这个匹配适合",
      "strength_areas": ["候选人对该岗位的优势领域", ...],
      "gap_areas": ["候选人对该岗位有待提升的领域", ...]
    }
  ]
}

匹配评分权重：
1. 技能匹配（40%）：候选人技能与岗位要求的重合度，核心技能优先于加分项
2. 经验相关性（30%）：候选人的实习/项目经验与岗位和行业的匹配度
3. 学历匹配（15%）：学位水平和专业是否对口
4. 地点/后勤（10%）：候选人能否在该岗位所在地工作
5. 行业偏好（5%）：岗位所在行业是否符合候选人偏好

规则：
- 返回恰好 {top_k} 个匹配（如岗位总数少于 {top_k}，返回全部）。
- match_score 低于 3 的岗位不要返回（匹配度太低）。
- 按 match_score 降序排列。
- 实话实说，不要虚高打分。
- 所有字符串字段使用中文输出。"""


def match_jobs(structured_resume: dict, jobs: list[dict], preferences: dict, client: Anthropic, top_k: int = DEFAULT_TOP_K) -> list[dict]:
    """将简历与岗位列表进行匹配，返回 Top K 匹配结果。支持分批策略。"""
    if not client:
        return [{"_error": "未配置 API Key"}]
    if not jobs:
        return []

    top_k = min(top_k, len(jobs))

    # 如果岗位数量超过批次上限，使用分批策略
    if len(jobs) > MAX_JOBS_PER_BATCH:
        return _batch_match(structured_resume, jobs, preferences, client, top_k)

    return _single_match(structured_resume, jobs, preferences, client, top_k)


def _single_match(resume: dict, jobs: list[dict], preferences: dict, client: Anthropic, top_k: int) -> list[dict]:
    """单次匹配（岗位数 ≤ 30）。"""
    prompt = SYSTEM_PROMPT.replace("{top_k}", str(top_k))
    user_msg = f"""候选人档案：
{json.dumps(resume, ensure_ascii=False, indent=2)}

候选人偏好：
- 意向行业：{preferences.get('industries', '不限')}
- 意向地点：{preferences.get('locations', '不限')}
- 最低薪资：{preferences.get('salary_min', '面议')}
- 岗位类型：{preferences.get('job_type', '全职')}

可投递岗位：
{json.dumps(jobs, ensure_ascii=False, indent=2)}

请找出最合适的 {top_k} 个匹配岗位并返回 JSON 结果。"""

    try:
        message = client.messages.create(
            model=MODEL_NAME,
            max_tokens=3000,
            temperature=0.2,
            system=prompt,
            messages=[{"role": "user", "content": user_msg}],
        )
        response_text = get_text_block(message.content).strip()
        data = parse_json_response(response_text)
        return data.get("matches", [])
    except Exception as e:
        return [{"_error": f"匹配失败: {str(e)}"}]


def _batch_match(resume: dict, jobs: list[dict], preferences: dict, client: Anthropic, top_k: int) -> list[dict]:
    """分批匹配策略：将岗位分成多批，每批选出 Top 6，汇总后再做最终排名。"""
    import math

    batch_size = MAX_JOBS_PER_BATCH
    batches = [jobs[i:i + batch_size] for i in range(0, len(jobs), batch_size)]
    per_batch_k = min(6, top_k)

    winners = []
    seen_ids = set()
    for batch in batches:
        batch_results = _single_match(resume, batch, preferences, client, per_batch_k)
        for match in batch_results:
            jid = match.get("job_id", "")
            if jid and jid not in seen_ids:
                seen_ids.add(jid)
                winners.append(match)

    if len(winners) <= top_k:
        winners.sort(key=lambda m: m.get("match_score", 0), reverse=True)
        return winners[:top_k]

    # 将胜出者再发给 Claude 做最终排名
    winners_jobs = [j for j in jobs if j.get("job_id") in {w.get("job_id") for w in winners}]
    final_results = _single_match(resume, winners_jobs, preferences, client, top_k)
    return final_results if final_results else winners[:top_k]

