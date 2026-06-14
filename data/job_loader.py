import os
import pandas as pd

CSV_PATH = os.path.join(os.path.dirname(__file__), "jobs.csv")
REQUIRED_COLUMNS = [
    "job_id", "title", "company", "industry", "location",
    "salary_range", "experience_level", "education_required",
    "description", "requirements"
]


def load_jobs(csv_path: str = CSV_PATH) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    for col in REQUIRED_COLUMNS:
        if col not in df.columns:
            raise ValueError(f"CSV 缺少必需列: {col}")
    return df


def filter_jobs(
    df: pd.DataFrame,
    industries: list[str] | None = None,
    locations: list[str] | None = None,
    experience_levels: list[str] | None = None,
    keyword: str | None = None,
) -> pd.DataFrame:
    result = df.copy()
    if industries:
        result = result[result["industry"].isin(industries)]
    if locations:
        result = result[result["location"].isin(locations)]
    if experience_levels:
        result = result[result["experience_level"].isin(experience_levels)]
    if keyword and keyword.strip():
        kw = keyword.strip().lower()
        mask = (
            result["title"].str.lower().str.contains(kw, na=False)
            | result["description"].str.lower().str.contains(kw, na=False)
            | result["requirements"].str.lower().str.contains(kw, na=False)
            | result["company"].str.lower().str.contains(kw, na=False)
        )
        result = result[mask]
    return result


def get_job_by_id(df: pd.DataFrame, job_id: str) -> dict | None:
    rows = df[df["job_id"] == job_id]
    if rows.empty:
        return None
    return rows.iloc[0].to_dict()


def get_job_summaries(df: pd.DataFrame) -> list[dict]:
    """返回岗位摘要列表，用于匹配 prompt（减少 token 消耗）。"""
    summaries = []
    for _, row in df.iterrows():
        summaries.append({
            "job_id": row["job_id"],
            "title": row["title"],
            "company": row["company"],
            "industry": row["industry"],
            "location": row["location"],
            "experience_level": row["experience_level"],
            "education_required": row["education_required"],
            "salary_range": row["salary_range"],
            "description": row["description"],
            "requirements": row["requirements"],
        })
    return summaries
