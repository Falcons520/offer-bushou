import os, shutil

# 每次启动自动清理字节码缓存，确保加载最新代码
_base = os.path.dirname(os.path.abspath(__file__))
for root, dirs, _files in os.walk(_base):
    if "__pycache__" in dirs:
        try:
            shutil.rmtree(os.path.join(root, "__pycache__"))
        except OSError:
            pass

import streamlit as st
import pandas as pd
from anthropic import Anthropic

from utils.config import (
    MODEL_NAME, load_api_key, INDUSTRIES, LOCATIONS,
    EXPERIENCE_LEVELS, JOB_TYPES, DEFAULT_TOP_K,
)
from engine.resume_parser import extract_text_from_file
from engine.extractor import extract_resume
from engine.matcher import match_jobs
from engine.optimizer import optimize_resume
from data.job_loader import load_jobs, filter_jobs, get_job_summaries

# ── Page Config ──────────────────────────────────────────────
st.set_page_config(
    page_title="Offer 捕手 | AI 求职匹配引擎",
    page_icon="🎯",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ── Session State ────────────────────────────────────────────
DEFAULTS = {
    "step": 1,
    "resume_text": None,
    "structured_resume": None,
    "preferences": {},
    "matches": None,
    "optimizations": {},
    "optimizing_job_id": None,
    "jobs_df": None,
    "client_ready": False,
}
for key, val in DEFAULTS.items():
    if key not in st.session_state:
        st.session_state[key] = val


# ── Helpers ──────────────────────────────────────────────────
def init_client():
    api_key = load_api_key()
    if api_key:
        return Anthropic(api_key=api_key)
    return None


def go_to_step(step: int):
    st.session_state.step = step


def render_score_bar(score, max_score=10):
    pct = score / max_score
    color = "#EF4444" if pct < 0.4 else ("#F59E0B" if pct < 0.7 else "#10B981")
    return f"""
    <div style="background:#E5E7EB;border-radius:8px;height:12px;width:100%;margin:4px 0;">
        <div style="background:{color};border-radius:8px;height:12px;width:{pct*100}%;"></div>
    </div>
    """


def _generate_report(job, opt: dict) -> str:
    """生成 Markdown 格式的优化报告。"""
    lines = [
        f"# 简历优化报告",
        f"",
        f"**目标岗位**: {job['title']} @ {job['company']}",
        f"**地点**: {job['location']} | **薪资**: {job['salary_range']}",
        f"**综合匹配分**: {opt.get('overall_fit_score', 'N/A')}/100",
        f"",
        f"---",
        f"",
        f"## 差距分析",
    ]
    for gap in opt.get("gap_analysis", []):
        sev = {"high": "高", "medium": "中", "low": "低"}.get(gap["severity"], gap["severity"])
        lines.append(f"- **[{sev}] {gap['area']}**: {gap['gap_description']}")
        lines.append(f"  - 建议: {gap['suggestion']}")

    lines += ["", "---", "", "## 简历修改建议"]
    for o in opt.get("resume_optimizations", []):
        lines.append(f"### {o.get('section', '')}")
        lines.append(f"- **操作**: {o.get('action', '')}")
        if o.get("original_text"):
            lines.append(f"- **原文**: {o['original_text']}")
        lines.append(f"- **建议**: {o.get('suggested_text', '')}")
        lines.append(f"- **理由**: {o.get('rationale', '')}")

    lines += ["", "---", "", "## 关键词策略"]
    for kw in opt.get("keyword_strategy", []):
        lines.append(f"- {kw}")

    lines += ["", "---", "", "## 求职信建议"]
    for tip in opt.get("cover_letter_tips", []):
        lines.append(f"- {tip}")

    lines += ["", "---", "", "## 面试准备"]
    for q in opt.get("interview_prep", []):
        lines.append(f"- {q}")

    lines += ["", "---", "", "*本报告由 AI 生成，仅供参考。祝你求职顺利！🎯*"]
    return "\n".join(lines)


def _reset_session():
    for key in list(st.session_state.keys()):
        del st.session_state[key]
    st.rerun()


# ── Sidebar ──────────────────────────────────────────────────
with st.sidebar:
    st.title("🎯 Offer 捕手")
    st.caption("AI 驱动的求职匹配引擎")
    st.divider()

    st.subheader("🔑 API Key")
    api_key_input = st.text_input(
        "Anthropic API Key",
        type="password",
        value=load_api_key(),
        help="输入你的 Claude API Key，仅用于当前会话，不会被存储。",
        placeholder="sk-ant-...",
    )
    if api_key_input:
        st.session_state.client_ready = True
        st.session_state._client = Anthropic(api_key=api_key_input)
    else:
        st.session_state.client_ready = False
        st.session_state._client = None

    st.divider()

    st.subheader("📋 流程")
    steps = {1: "① 上传简历", 2: "② 确认档案", 3: "③ 岗位匹配", 4: "④ 优化建议"}
    for i, label in steps.items():
        if st.session_state.step == i:
            st.markdown(f"**→ {label}**")
        elif st.session_state.step > i:
            st.markdown(f"✓ {label}")
        else:
            st.markdown(f"  {label}")

    st.divider()

    st.caption("Powered by Claude API")
    st.caption("Made with Streamlit")


# ── Step 1: Upload ───────────────────────────────────────────
if st.session_state.step == 1:
    st.header("① 上传你的简历")
    st.caption("支持 PDF 和 DOCX 格式，简历内容仅用于当前会话，不会保存到服务器。")

    col1, col2 = st.columns([1, 1])

    with col1:
        uploaded_file = st.file_uploader("选择简历文件", type=["pdf", "docx"], key="file_uploader")

        st.divider()
        st.subheader("求职偏好（可选）")
        preferences = {}
        preferences["industries"] = st.multiselect("意向行业", INDUSTRIES, key="pref_industry")
        preferences["locations"] = st.multiselect("意向城市", LOCATIONS, key="pref_location")
        preferences["salary_min"] = st.selectbox("最低薪资期望", ["面议", "8k-12k", "12k-18k", "18k-25k", "25k-35k", "35k+"], key="pref_salary")
        preferences["experience_level"] = st.selectbox("经验水平", ["不限"] + EXPERIENCE_LEVELS, key="pref_exp")
        preferences["job_type"] = st.selectbox("岗位类型", JOB_TYPES, key="pref_job_type")

        parse_btn = st.button("📄 解析简历", type="primary", use_container_width=True, disabled=not st.session_state.client_ready)

    with col2:
        if uploaded_file and parse_btn:
            if not st.session_state.client_ready:
                st.warning("请先在左侧边栏输入 API Key")
            else:
                with st.spinner("正在提取文本..."):
                    result = extract_text_from_file(uploaded_file)

                if not result["success"]:
                    st.error(result.get("error", "解析失败"))
                else:
                    st.session_state.resume_text = result["text"]
                    if result.get("error"):
                        st.warning(result["error"])

                    with st.spinner("🤖 AI 正在分析简历..."):
                        st.session_state.structured_resume = extract_resume(
                            result["text"], st.session_state._client
                        )

                    st.session_state.preferences = preferences
                    st.session_state.jobs_df = load_jobs()

                    if st.session_state.structured_resume.get("_error"):
                        st.error(st.session_state.structured_resume["_error"])
                    else:
                        st.success("简历解析完成！")
                        st.button("下一步 → 确认档案", on_click=go_to_step, args=(2,), type="primary")

        elif not uploaded_file:
            st.info("👈 请上传你的简历文件（PDF 或 DOCX）")


# ── Step 2: Review ───────────────────────────────────────────
elif st.session_state.step == 2:
    st.header("② 确认你的档案")
    st.caption("AI 从简历中提取了以下信息，请核对并修改不准确的地方。")

    resume = st.session_state.structured_resume
    if not resume:
        st.warning("未找到解析结果，请返回上一步。")
        st.button("← 返回上传", on_click=go_to_step, args=(1,))
    else:
        col_a, col_b = st.columns(2)

        with col_a:
            st.subheader("基本信息")
            resume["name"] = st.text_input("姓名", value=resume.get("name") or "")
            resume["email"] = st.text_input("邮箱", value=resume.get("email") or "")
            resume["phone"] = st.text_input("电话", value=resume.get("phone") or "")

            st.subheader("技能")
            skills_text = st.text_area(
                "技能（每行一个）",
                value="\n".join(resume.get("skills", [])),
                height=150,
            )
            resume["skills"] = [s.strip() for s in skills_text.split("\n") if s.strip()]

            st.subheader("证书/资质")
            certs_text = st.text_area(
                "证书（每行一个）",
                value="\n".join(resume.get("certifications", [])),
                height=100,
            )
            resume["certifications"] = [c.strip() for c in certs_text.split("\n") if c.strip()]

        with col_b:
            st.subheader("教育经历")
            edu_rows = []
            for i, edu in enumerate(resume.get("education", [])):
                edu_rows.append({
                    "degree": st.text_input(f"学位 #{i+1}", value=edu.get("degree", ""), key=f"edu_deg_{i}"),
                    "school": st.text_input(f"学校 #{i+1}", value=edu.get("school", ""), key=f"edu_sch_{i}"),
                    "major": st.text_input(f"专业 #{i+1}", value=edu.get("major", ""), key=f"edu_maj_{i}"),
                    "year": st.text_input(f"毕业年份 #{i+1}", value=edu.get("year") or "", key=f"edu_yr_{i}"),
                })
            resume["education"] = [e for e in edu_rows if any(e.values())]

            st.subheader("工作/实习经历")
            for i, exp in enumerate(resume.get("experience", [])):
                with st.expander(f"{exp.get('title', '未命名')} @ {exp.get('company', '未知')}", expanded=i == 0):
                    exp["title"] = st.text_input("职位", value=exp.get("title", ""), key=f"exp_t_{i}")
                    exp["company"] = st.text_input("公司", value=exp.get("company", ""), key=f"exp_c_{i}")
                    exp["duration"] = st.text_input("时间", value=exp.get("duration", ""), key=f"exp_d_{i}")
                    hl_text = st.text_area(
                        "工作亮点（每行一个）",
                        value="\n".join(exp.get("highlights", [])),
                        key=f"exp_hl_{i}",
                    )
                    exp["highlights"] = [h.strip() for h in hl_text.split("\n") if h.strip()]

        st.subheader("项目经历")
        for i, proj in enumerate(resume.get("projects", [])):
            with st.expander(f"项目: {proj.get('name', '未命名')}", expanded=False):
                proj["name"] = st.text_input("项目名称", value=proj.get("name", ""), key=f"proj_n_{i}")
                proj["description"] = st.text_area("项目描述", value=proj.get("description", ""), key=f"proj_d_{i}")
                tech_text = st.text_area(
                    "技术栈（每行一个）",
                    value="\n".join(proj.get("technologies", [])),
                    key=f"proj_t_{i}",
                )
                proj["technologies"] = [t.strip() for t in tech_text.split("\n") if t.strip()]

        st.divider()
        c1, c2 = st.columns([1, 1])
        with c1:
            st.button("← 返回上传", on_click=go_to_step, args=(1,))
        with c2:
            st.button("确认并开始匹配 →", type="primary", on_click=go_to_step, args=(3,))


# ── Step 3: Matches ──────────────────────────────────────────
elif st.session_state.step == 3:
    st.header("③ 岗位匹配结果")
    st.caption("AI 根据你的简历和偏好，从岗位库中智能匹配最合适的岗位。")

    resume = st.session_state.structured_resume
    jobs_df = st.session_state.jobs_df
    preferences = st.session_state.preferences

    if resume is None or jobs_df is None:
        st.warning("请先上传并解析简历。")
        st.button("← 返回上传", on_click=go_to_step, args=(1,))
    else:
        if st.session_state.matches is None:
            if not st.session_state.client_ready:
                st.warning("请先在左侧边栏输入 API key 后再开始匹配。")
            else:
                # Apply filters
                filtered_df = filter_jobs(
                    jobs_df,
                    industries=preferences.get("industries") or None,
                    locations=preferences.get("locations") or None,
                    experience_levels=[preferences["experience_level"]] if preferences.get("experience_level") and preferences["experience_level"] != "不限" else None,
                )
                if filtered_df.empty:
                    st.warning("没有符合筛选条件的岗位，已展示全部岗位库。")
                    filtered_df = jobs_df

                job_summaries = get_job_summaries(filtered_df)

                with st.spinner(f"🤖 AI 正在从 {len(job_summaries)} 个岗位中匹配最适合你的机会..."):
                    st.session_state.matches = match_jobs(
                        resume, job_summaries, preferences,
                        st.session_state._client, top_k=DEFAULT_TOP_K,
                    )

        matches = st.session_state.matches or []

        if matches and matches[0].get("_error"):
            st.error(matches[0]["_error"])
        elif matches:
            # Summary metrics
            scores = [m.get("match_score", 0) for m in matches]
            c1, c2, c3 = st.columns(3)
            with c1:
                st.metric("匹配岗位数", len(matches))
            with c2:
                st.metric("最高匹配分", f"{max(scores):.0f}/10" if scores else "N/A")
            with c3:
                st.metric("平均匹配分", f"{sum(scores)/len(scores):.1f}/10" if scores else "N/A")

            st.divider()

            for i, match in enumerate(matches):
                job_id = match.get("job_id", "")
                job_info = jobs_df[jobs_df["job_id"] == job_id]
                if job_info.empty:
                    continue
                job = job_info.iloc[0]

                score = match.get("match_score", 0)
                pct = score / 10

                with st.container():
                    col_main, col_btn = st.columns([4, 1])
                    with col_main:
                        st.subheader(f"{'🔥' if score >= 8 else '⭐' if score >= 6 else '💡'} {job['title']} — {job['company']}")
                        st.caption(f"📍 {job['location']} | 💰 {job['salary_range']} | 🏷 {job['industry']} | 🎓 {job['experience_level']}")

                        st.markdown(render_score_bar(score, 10), unsafe_allow_html=True)
                        st.caption(f"匹配度: **{score}/10**")

                        st.write(match.get("match_summary", ""))

                        col_s, col_g = st.columns(2)
                        with col_s:
                            strengths = match.get("strength_areas", [])
                            if strengths:
                                st.markdown("**✅ 优势领域**")
                                for s in strengths:
                                    st.success(s)
                        with col_g:
                            gaps = match.get("gap_areas", [])
                            if gaps:
                                st.markdown("**⚠️ 待提升**")
                                for g in gaps:
                                    st.warning(g)

                        with st.expander("📋 岗位详情"):
                            st.markdown(f"**岗位描述**: {job['description']}")
                            st.markdown(f"**岗位要求**: {job['requirements']}")

                    with col_btn:
                        st.write("")
                        st.write("")
                        if st.button(f"🔍 优化简历", key=f"opt_btn_{i}", type="primary"):
                            st.session_state.optimizing_job_id = job_id
                            st.session_state.optimizations[job_id] = None
                            go_to_step(4)
                            st.rerun()

                    st.divider()
        else:
            st.warning("未找到匹配的岗位，请尝试调整筛选条件。")

        st.button("← 返回修改偏好", on_click=go_to_step, args=(2,))


# ── Step 4: Optimization ─────────────────────────────────────
elif st.session_state.step == 4:
    st.header("④ 简历优化建议")
    st.caption("AI 分析你的简历与目标岗位的差距，提供具体可操作的优化方案。")

    job_id = st.session_state.optimizing_job_id
    df = st.session_state.jobs_df
    if not job_id or df is None:
        st.warning("请先从匹配结果中选择一个岗位。")
        st.button("← 返回匹配结果", on_click=go_to_step, args=(3,))
    else:
        job = df[df["job_id"] == job_id].iloc[0]
        resume = st.session_state.structured_resume

        st.subheader(f"目标岗位: {job['title']} @ {job['company']}")
        st.caption(f"📍 {job['location']} | 💰 {job['salary_range']} | 🏷 {job['industry']}")

        # Run optimization if not yet done
        if st.session_state.optimizations.get(job_id) is None:
            if not st.session_state.client_ready:
                st.warning("请先在左侧边栏输入 API key。")
            else:
                with st.spinner("🤖 AI 正在深度分析简历与岗位的匹配度..."):
                    result = optimize_resume(
                        resume,
                        {
                            "job_id": job["job_id"],
                            "title": job["title"],
                            "company": job["company"],
                            "industry": job["industry"],
                            "location": job["location"],
                            "experience_level": job["experience_level"],
                            "education_required": job["education_required"],
                            "description": job["description"],
                            "requirements": job["requirements"],
                        },
                        st.session_state._client,
                    )
                st.session_state.optimizations[job_id] = result

        opt = st.session_state.optimizations.get(job_id, {})

        if opt.get("_error"):
            st.error(opt["_error"])
        elif opt:
            fit_score = opt.get("overall_fit_score", 0)
            fit_pct = fit_score / 100

            col_score, _ = st.columns([1, 3])
            with col_score:
                color = "#EF4444" if fit_pct < 0.4 else ("#F59E0B" if fit_pct < 0.7 else "#10B981")
                st.markdown(
                    f"""
                    <div style="text-align:center;padding:20px;border-radius:12px;background:{color}15;">
                        <div style="font-size:48px;font-weight:bold;color:{color};">{fit_score}</div>
                        <div style="color:#6B7280;">综合匹配分 /100</div>
                    </div>
                    """,
                    unsafe_allow_html=True,
                )

            # Gap analysis
            st.divider()
            st.subheader("📊 差距分析")
            gaps = opt.get("gap_analysis", [])
            if gaps:
                gap_df = pd.DataFrame(gaps)
                severity_order = {"high": 0, "medium": 1, "low": 2}
                gap_df["_sev_order"] = gap_df["severity"].map(severity_order)
                gap_df = gap_df.sort_values("_sev_order").drop(columns=["_sev_order"])

                for _, gap in gap_df.iterrows():
                    sev = gap["severity"]
                    sev_label = {"high": "🔴 高", "medium": "🟡 中", "low": "🟢 低"}.get(sev, sev)
                    with st.expander(f"{sev_label} | {gap['area']} — {gap['gap_description'][:60]}...", expanded=sev == "high"):
                        st.markdown(f"**问题**: {gap['gap_description']}")
                        st.markdown(f"**建议**: {gap['suggestion']}")

            # Resume optimizations (side-by-side)
            st.divider()
            st.subheader("✏️ 简历修改建议")
            optimizations = opt.get("resume_optimizations", [])
            if optimizations:
                for i, o in enumerate(optimizations):
                    action_label = {
                        "rewrite": "重写", "add": "新增", "remove": "删除",
                        "reorder": "调整顺序", "highlight": "突出展示"
                    }.get(o.get("action"), o.get("action"))

                    with st.expander(f"{action_label} → {o.get('section', '未知')}", expanded=i < 3):
                        col_orig, col_sug = st.columns(2)
                        with col_orig:
                            st.markdown("**原文**")
                            st.text_area(
                                "原文",
                                value=o.get("original_text") or "（新增内容，无原文）",
                                height=120,
                                disabled=True,
                                key=f"orig_{i}",
                                label_visibility="collapsed",
                            )
                        with col_sug:
                            st.markdown("**建议修改**")
                            st.text_area(
                                "建议",
                                value=o.get("suggested_text", ""),
                                height=120,
                                key=f"sug_{i}",
                                label_visibility="collapsed",
                            )
                        st.markdown(f"**💡 修改理由**: {o.get('rationale', '')}")

            # Keywords
            keywords = opt.get("keyword_strategy", [])
            if keywords:
                st.divider()
                st.subheader("🏷 关键词策略")
                st.caption("建议在简历中自然融入以下关键词，以通过ATS系统筛选：")
                st.markdown(" ".join([f"`{kw}`" for kw in keywords]))

            # Cover letter tips
            cl_tips = opt.get("cover_letter_tips", [])
            if cl_tips:
                st.divider()
                st.subheader("📝 求职信建议")
                for tip in cl_tips:
                    st.markdown(f"- {tip}")

            # Interview prep
            interview = opt.get("interview_prep", [])
            if interview:
                st.divider()
                st.subheader("🎤 面试准备")
                for q in interview:
                    st.markdown(f"- {q}")

            # Download report
            st.divider()
            report_md = _generate_report(job, opt)
            st.download_button(
                label="📥 下载优化报告（Markdown）",
                data=report_md,
                file_name=f"简历优化报告_{job['title']}_{job['company']}.md",
                mime="text/markdown",
            )

        st.divider()
        c1, c2 = st.columns(2)
        with c1:
            st.button("← 返回匹配结果", on_click=go_to_step, args=(3,))
        with c2:
            if st.button("🔄 重新开始"):
                _reset_session()


# ── Footer ──────────────────────────────────────────────────
st.divider()
st.caption("🎯 Offer 捕手 — AI 驱动的求职匹配引擎 | Powered by Claude API | 仅用于学习与研究目的")
