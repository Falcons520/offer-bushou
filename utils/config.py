import os
import streamlit as st

MODEL_NAME = "claude-sonnet-4-20250514"
MAX_JOBS_PER_BATCH = 30
DEFAULT_TOP_K = 10


def load_api_key() -> str:
    """从 Streamlit secrets 或环境变量加载 API key。"""
    try:
        return st.secrets["ANTHROPIC_API_KEY"]
    except Exception:
        return os.environ.get("ANTHROPIC_API_KEY", "")


def get_client():
    """延迟导入 Anthropic 客户端，避免冷启动时的开销。"""
    from anthropic import Anthropic

    api_key = load_api_key()
    if not api_key:
        return None
    return Anthropic(api_key=api_key)


INDUSTRIES = [
    "互联网/科技", "金融/银行", "咨询", "消费品/零售",
    "制造业", "医疗/医药", "教育", "能源/化工", "房地产",
]

LOCATIONS = [
    "北京", "上海", "广州", "深圳", "杭州", "成都", "武汉",
    "南京", "苏州", "西安", "Remote",
]

EXPERIENCE_LEVELS = ["应届生", "1-3年", "3-5年"]

JOB_TYPES = ["全职", "实习", "校招"]


def get_text_block(message_content) -> str:
    """从 Claude API 响应中提取第一个文本块。"""
    for block in message_content:
        if hasattr(block, "type") and getattr(block, "type") == "text":
            return str(getattr(block, "text", ""))
    return ""


def parse_json_response(text: str) -> dict:
    """清理并解析 Claude 返回的 JSON（处理 markdown 代码块包裹）。"""
    import json

    text = text.strip()
    if text.startswith("```json"):
        text = text[7:]
    elif text.startswith("```"):
        text = text[3:]
    if text.endswith("```"):
        text = text[:-3]
    return json.loads(text.strip())
