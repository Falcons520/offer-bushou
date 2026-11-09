(() => {
  "use strict";

  const MODEL_NAME = "claude-sonnet-4-20250514";
  const MAX_JOBS_PER_BATCH = 30;
  const DEFAULT_TOP_K = 10;
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const API_KEY_STORAGE = "offer-bushou-api-key";

  const INDUSTRIES = [
    "互联网/科技", "金融/银行", "咨询", "消费品/零售",
    "制造业", "医疗/医药", "教育", "能源/化工", "房地产"
  ];

  const LOCATIONS = [
    "北京", "上海", "广州", "深圳", "杭州", "成都", "武汉",
    "南京", "苏州", "西安", "Remote"
  ];

  const EXPERIENCE_LEVELS = ["应届生", "1-3年", "3-5年"];
  const JOB_TYPES = ["全职", "实习", "校招"];
  const SALARY_OPTIONS = ["面议", "8k-12k", "12k-18k", "18k-25k", "25k-35k", "35k+"];

  const STEPS = {
    1: { title: "上传简历", subtitle: "文件与求职偏好" },
    2: { title: "确认档案", subtitle: "校对结构化信息" },
    3: { title: "岗位匹配", subtitle: "查看推荐结果" },
    4: { title: "优化建议", subtitle: "差距与修改方案" }
  };

  const state = {
    step: 1,
    maxStep: 1,
    apiKey: "",
    resumeFile: null,
    resumeText: "",
    resumeWarning: "",
    structuredResume: null,
    preferences: {
      industries: [],
      locations: [],
      salary_min: "面议",
      experience_level: "不限",
      job_type: "全职"
    },
    jobs: null,
    jobsPromise: null,
    matches: null,
    matchError: "",
    matchFallbackWarning: false,
    matching: false,
    matchingDetail: "",
    matchScheduled: false,
    optimizingJobId: null,
    optimizations: {},
    optimizing: false,
    optimizationDetail: "",
    optimizationScheduled: false,
    busy: null
  };

  const els = {};

  const RESUME_SYSTEM_PROMPT = `你是一个精确的简历解析引擎。你的任务是从原始简历文本中提取结构化信息。

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
5. 所有字符串使用简历的原始语言输出。`;

  const MATCH_SYSTEM_PROMPT = `你是一位资深职业顾问和求职匹配专家，专注于中国市场。你的任务是将候选人的结构化简历与岗位列表进行匹配，返回最佳匹配结果。

只输出有效的 JSON。不要包含 markdown 代码块标记或解释性文字。

JSON 格式：
{
  "matches": [
    {
      "job_id": "岗位ID",
      "match_score": 8,
      "match_summary": "1-2句话中文说明为什么这个匹配适合",
      "strength_areas": ["候选人对该岗位的优势领域"],
      "gap_areas": ["候选人对该岗位有待提升的领域"]
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
- 所有字符串字段使用中文输出。`;

  const OPTIMIZE_SYSTEM_PROMPT = `你是一位资深HR和职业教练，专门帮助中国学生和职场新人针对具体岗位优化简历，提高简历初筛命中率。

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
  "keyword_strategy": ["应自然融入简历的岗位描述关键词"],
  "cover_letter_tips": ["针对该岗位的求职信撰写建议3-5条（中文）"],
  "interview_prep": ["该岗位可能问到的面试问题或需要准备的话题3-5个（中文）"]
}

优化原则：
1. 绝对不要编造候选人不具备的技能或经历。
2. 重点在于重新表述现有经历，用岗位描述中的语言来更好地对齐。
3. 识别不相关经历中可迁移到目标岗位的能力。
4. 如果简历中存在相关的课程项目或学术项目，建议突出展示。
5. 仅当缺少硬性门槛资质时，才建议考取证书或学习资源。
6. 所有输出文本使用中文，技术术语保持原文。
7. suggested_text 要写出完整的、润色好的 bullet point，可直接粘贴到简历中。`;

  function init() {
    els.app = document.getElementById("app");
    els.sidebar = document.getElementById("sidebar");
    els.sidebarBackdrop = document.getElementById("sidebarBackdrop");
    els.workflowNav = document.getElementById("workflowNav");
    els.pageTitle = document.getElementById("pageTitle");
    els.apiKey = document.getElementById("apiKey");
    els.apiStatus = document.getElementById("apiStatus");
    els.connectionStatus = document.getElementById("connectionStatus");
    els.toastStack = document.getElementById("toastStack");

    try {
      state.apiKey = sessionStorage.getItem(API_KEY_STORAGE) || "";
    } catch {
      state.apiKey = "";
    }
    els.apiKey.value = state.apiKey;

    bindEvents();
    updateApiUi();
    render();
  }

  function bindEvents() {
    document.addEventListener("click", handleDocumentClick);
    els.app.addEventListener("input", handleAppInput);
    els.app.addEventListener("change", handleAppChange);
    els.app.addEventListener("dragover", handleDragOver);
    els.app.addEventListener("dragleave", handleDragLeave);
    els.app.addEventListener("drop", handleDrop);

    els.apiKey.addEventListener("input", () => {
      const wasReady = isApiReady();
      state.apiKey = els.apiKey.value.trim();
      persistApiKey();
      updateApiUi();
      if (wasReady !== isApiReady()) {
        render();
      }
    });

    document.getElementById("toggleApiKey").addEventListener("click", (event) => {
      const button = event.currentTarget;
      const show = els.apiKey.type === "password";
      els.apiKey.type = show ? "text" : "password";
      button.title = show ? "隐藏 API Key" : "显示 API Key";
      button.setAttribute("aria-label", button.title);
      button.innerHTML = `<i data-lucide="${show ? "eye-off" : "eye"}"></i>`;
      refreshIcons();
    });

    document.getElementById("clearApiKey").addEventListener("click", () => {
      state.apiKey = "";
      els.apiKey.value = "";
      persistApiKey();
      updateApiUi();
      showToast("API Key 已清除。", "info");
      render();
    });

    document.getElementById("mobileMenu").addEventListener("click", openSidebar);
    els.sidebarBackdrop.addEventListener("click", closeSidebar);

    document.getElementById("resetApp").addEventListener("click", resetWorkflow);
  }

  function handleDocumentClick(event) {
    const navButton = event.target.closest("[data-nav-step]");
    if (navButton) {
      goToStep(Number(navButton.dataset.navStep));
      return;
    }

    const chip = event.target.closest("[data-action='toggle-chip']");
    if (chip) {
      toggleChip(chip.dataset.group, chip.dataset.value, chip);
      return;
    }

    const segment = event.target.closest("[data-action='select-segment']");
    if (segment) {
      const field = segment.dataset.field;
      const value = segment.dataset.value;
      state.preferences[field] = value;
      segment.parentElement.querySelectorAll(".segment").forEach((item) => {
        const active = item === segment;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      invalidateMatches();
      return;
    }

    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) {
      return;
    }

    const action = actionButton.dataset.action;
    switch (action) {
      case "start-parse":
        startParsing();
        break;
      case "remove-file":
        state.resumeFile = null;
        state.resumeWarning = "";
        render();
        break;
      case "choose-file":
        document.getElementById("resumeFile")?.click();
        break;
      case "add-education":
        invalidateMatches();
        state.structuredResume.education.push({ degree: "", school: "", major: "", year: "" });
        render();
        break;
      case "remove-education":
        invalidateMatches();
        state.structuredResume.education.splice(Number(actionButton.dataset.index), 1);
        render();
        break;
      case "add-experience":
        invalidateMatches();
        state.structuredResume.experience.push({ title: "", company: "", duration: "", highlights: [] });
        render();
        break;
      case "remove-experience":
        invalidateMatches();
        state.structuredResume.experience.splice(Number(actionButton.dataset.index), 1);
        render();
        break;
      case "add-project":
        invalidateMatches();
        state.structuredResume.projects.push({ name: "", description: "", technologies: [] });
        render();
        break;
      case "remove-project":
        invalidateMatches();
        state.structuredResume.projects.splice(Number(actionButton.dataset.index), 1);
        render();
        break;
      case "go-step":
        goToStep(Number(actionButton.dataset.step));
        break;
      case "start-matching":
        if (!state.structuredResume) {
          showToast("请先解析简历。", "warning");
          return;
        }
        state.matches = null;
        state.matchError = "";
        state.maxStep = Math.max(state.maxStep, 3);
        state.step = 3;
        render();
        break;
      case "retry-match":
        state.matches = null;
        state.matchError = "";
        state.matchScheduled = false;
        render();
        break;
      case "open-optimization":
        openOptimization(actionButton.dataset.jobId);
        break;
      case "retry-optimization":
        state.optimizations[state.optimizingJobId] = null;
        state.optimizationScheduled = false;
        render();
        break;
      case "download-report":
        downloadReport();
        break;
      case "copy-suggestion":
        copySuggestion(Number(actionButton.dataset.index), actionButton);
        break;
      case "reset-workflow":
        resetWorkflow();
        break;
      default:
        break;
    }
  }

  function handleAppInput(event) {
    const field = event.target.closest("[data-bind]");
    if (!field || !state.structuredResume) {
      return;
    }

    const path = field.dataset.bind;
    let value = field.value;
    if (field.dataset.lines === "true") {
      value = value.split("\n").map((item) => item.trim()).filter(Boolean);
    }
    setPath(state.structuredResume, path, value);
    invalidateMatches();
  }

  function handleAppChange(event) {
    if (event.target.id === "resumeFile") {
      const file = event.target.files?.[0];
      if (file) {
        setResumeFile(file);
      }
    }

    if (event.target.matches("[data-pref]")) {
      state.preferences[event.target.dataset.pref] = event.target.value;
      invalidateMatches();
    }
  }

  function handleDragOver(event) {
    const zone = event.target.closest("[data-upload-zone]");
    if (!zone) {
      return;
    }
    event.preventDefault();
    zone.classList.add("dragover");
  }

  function handleDragLeave(event) {
    const zone = event.target.closest("[data-upload-zone]");
    if (zone) {
      zone.classList.remove("dragover");
    }
  }

  function handleDrop(event) {
    const zone = event.target.closest("[data-upload-zone]");
    if (!zone) {
      return;
    }
    event.preventDefault();
    zone.classList.remove("dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      setResumeFile(file);
    }
  }

  function render() {
    renderWorkflow();
    renderHeader();
    updateApiUi();

    let html = "";
    if (state.step === 1) {
      html = renderStep1();
    } else if (state.step === 2) {
      html = renderStep2();
    } else if (state.step === 3) {
      html = renderStep3();
    } else {
      html = renderStep4();
    }

    els.app.innerHTML = html;
    refreshIcons();
  }

  function renderWorkflow() {
    els.workflowNav.innerHTML = Object.entries(STEPS).map(([value, item]) => {
      const step = Number(value);
      const active = state.step === step;
      const complete = state.step > step;
      const disabled = !canNavigate(step);
      return `
        <button
          class="workflow-item ${active ? "active" : ""} ${complete ? "complete" : ""}"
          type="button"
          data-nav-step="${step}"
          ${disabled ? "disabled" : ""}
          aria-current="${active ? "step" : "false"}"
        >
          <span class="workflow-index">${complete ? "✓" : String(step).padStart(2, "0")}</span>
          <span class="workflow-copy">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.subtitle)}</span>
          </span>
          <span class="workflow-state">${complete ? '<i data-lucide="check"></i>' : ""}</span>
        </button>
      `;
    }).join("");
  }

  function renderHeader() {
    els.pageTitle.textContent = STEPS[state.step].title;
    document.title = `${STEPS[state.step].title} | Offer 捕手`;
  }

  function updateApiUi() {
    const ready = isApiReady();
    els.apiStatus.textContent = ready ? "已连接" : "未连接";
    els.apiStatus.classList.toggle("ready", ready);
    els.connectionStatus.classList.toggle("ready", ready);
    els.connectionStatus.lastElementChild.textContent = ready ? "Claude API 已就绪" : "等待 API Key";
  }

  function renderStep1() {
    if (state.busy?.type === "parse") {
      return `
        <section class="page-section">
          ${sectionIntro("01", "file-search", "上传简历", "系统会先在浏览器内读取文件，再将文本发送给 Claude 进行结构化解析。")}
          ${processingTemplate("file-search", state.busy.title, state.busy.detail)}
        </section>
      `;
    }

    const file = state.resumeFile;
    const parseDisabled = !file || !isApiReady();
    return `
      <section class="page-section">
        ${sectionIntro(
          "01",
          "file-up",
          "上传简历",
          "支持 PDF 与 DOCX。文件在浏览器内读取，原始文件不会上传到服务器。",
          `<div class="step-summary"><span>当前岗位库</span><strong>80</strong><span>个机会</span></div>`
        )}

        <div class="upload-layout">
          <section class="panel">
            <div class="panel-header">
              <div>
                <h3>简历文件</h3>
                <p>最大 10 MB，建议使用可复制文本的 PDF。</p>
              </div>
            </div>
            <div class="panel-body">
              <input id="resumeFile" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document">
              ${file ? renderFileCard(file) : renderUploadZone()}
              <div class="upload-notes">
                <div class="note-line"><i data-lucide="lock-keyhole"></i><span>解析过程和简历内容仅用于本次求职工作流。</span></div>
                <div class="note-line"><i data-lucide="file-text"></i><span>扫描版 PDF 可能无法提取文字，建议先转换为可编辑文本。</span></div>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-header">
              <div>
                <h3>求职偏好</h3>
                <p>这些条件会参与岗位筛选和匹配评分。</p>
              </div>
            </div>
            <div class="panel-body">
              <div class="preference-form">
                ${renderChipGroup("意向行业", "industries", INDUSTRIES, "可多选")}
                ${renderChipGroup("意向城市", "locations", LOCATIONS, "可多选")}
                <div class="field-row">
                  <div class="field-group">
                    <label class="field-label" for="salaryPreference">最低薪资期望</label>
                    <select class="select" id="salaryPreference" data-pref="salary_min">
                      ${SALARY_OPTIONS.map((option) => optionSelect(option, state.preferences.salary_min)).join("")}
                    </select>
                  </div>
                  <div class="field-group">
                    <span class="field-label">经验水平</span>
                    ${renderSegments("experience_level", ["不限", ...EXPERIENCE_LEVELS], state.preferences.experience_level)}
                  </div>
                </div>
                <div class="field-group">
                  <span class="field-label">岗位类型</span>
                  ${renderSegments("job_type", JOB_TYPES, state.preferences.job_type)}
                </div>
                ${state.resumeWarning ? `
                  <div class="alert warning">
                    <i data-lucide="triangle-alert"></i>
                    <span>${escapeHtml(state.resumeWarning)}</span>
                  </div>
                ` : ""}
                <button
                  class="button button-primary button-wide"
                  type="button"
                  data-action="start-parse"
                  ${parseDisabled ? "disabled" : ""}
                  title="${parseDisabled ? "请选择简历并填写 API Key" : "开始解析简历"}"
                >
                  <i data-lucide="sparkles"></i>
                  解析简历并生成档案
                </button>
              </div>
            </div>
          </section>
        </div>
      </section>
    `;
  }

  function renderUploadZone() {
    return `
      <label class="upload-zone" for="resumeFile" data-upload-zone>
        <span>
          <span class="upload-icon"><i data-lucide="upload-cloud"></i></span>
          <strong>选择或拖入简历文件</strong>
          <span>PDF / DOCX · 最大 10 MB</span>
        </span>
      </label>
    `;
  }

  function renderFileCard(file) {
    return `
      <div class="file-card" data-upload-zone>
        <span class="file-icon"><i data-lucide="file-text"></i></span>
        <div class="file-copy">
          <strong title="${escapeAttr(file.name)}">${escapeHtml(file.name)}</strong>
          <span>${formatBytes(file.size)} · ${file.name.toLowerCase().endsWith(".pdf") ? "PDF" : "DOCX"}</span>
        </div>
        <div class="bottom-actions-group">
          <button class="icon-button" type="button" data-action="choose-file" title="更换文件" aria-label="更换文件">
            <i data-lucide="refresh-cw"></i>
          </button>
          <button class="icon-button danger" type="button" data-action="remove-file" title="移除文件" aria-label="移除文件">
            <i data-lucide="x"></i>
          </button>
        </div>
      </div>
    `;
  }

  function renderChipGroup(label, group, values, hint) {
    return `
      <div class="field-group">
        <div class="field-caption">
          <span>${escapeHtml(label)}</span>
          <small>${escapeHtml(hint)}</small>
        </div>
        <div class="chip-group">
          ${values.map((value) => {
            const active = state.preferences[group].includes(value);
            return `
              <button
                class="chip ${active ? "active" : ""}"
                type="button"
                data-action="toggle-chip"
                data-group="${escapeAttr(group)}"
                data-value="${escapeAttr(value)}"
                aria-pressed="${active}"
              >
                ${active ? '<i data-lucide="check"></i>' : ""}
                ${escapeHtml(value)}
              </button>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function renderSegments(field, values, selected) {
    return `
      <div class="segmented">
        ${values.map((value) => `
          <button
            class="segment ${selected === value ? "active" : ""}"
            type="button"
            data-action="select-segment"
            data-field="${escapeAttr(field)}"
            data-value="${escapeAttr(value)}"
            aria-pressed="${selected === value}"
          >${escapeHtml(value)}</button>
        `).join("")}
      </div>
    `;
  }

  function renderStep2() {
    const resume = state.structuredResume;
    if (!resume) {
      return `
        <section class="page-section">
          ${sectionIntro("02", "badge-check", "确认档案", "校对 Claude 从简历中提取的信息。")}
          <div class="alert warning">
            <i data-lucide="triangle-alert"></i>
            <span>还没有可确认的简历档案。</span>
          </div>
          <div class="action-row end">
            <button class="button button-secondary" type="button" data-action="go-step" data-step="1">
              <i data-lucide="arrow-left"></i>
              返回上传
            </button>
          </div>
        </section>
      `;
    }

    return `
      <section class="page-section">
        ${sectionIntro(
          "02",
          "badge-check",
          "确认你的档案",
          "提取结果会参与后续匹配。请修正不准确的信息，也可以补充遗漏项。",
          `<div class="step-summary"><span>已识别</span><strong>${resume.skills.length}</strong><span>项技能</span></div>`
        )}

        <section class="panel form-panel">
          <div class="form-section">
            <div class="form-section-heading">
              <div>
                <h3>基本信息</h3>
                <p>用于生成个性化匹配与报告。</p>
              </div>
            </div>
            <div class="form-grid">
              ${formField("姓名", "name", resume.name || "", "text", "你的姓名")}
              ${formField("邮箱", "email", resume.email || "", "email", "name@example.com")}
              ${formField("电话", "phone", resume.phone || "", "tel", "手机或固定电话")}
            </div>
          </div>

          <div class="form-section">
            <div class="form-section-heading">
              <div>
                <h3>技能与资质</h3>
                <p>每行填写一项，便于后续精确匹配。</p>
              </div>
            </div>
            <div class="form-grid two">
              <div class="form-field">
                <label for="skillsInput">技能</label>
                <textarea class="textarea" id="skillsInput" data-bind="skills" data-lines="true" placeholder="Python&#10;SQL&#10;用户研究">${escapeHtml(resume.skills.join("\n"))}</textarea>
              </div>
              <div class="form-field">
                <label for="certsInput">证书 / 资质</label>
                <textarea class="textarea" id="certsInput" data-bind="certifications" data-lines="true" placeholder="CET-6&#10;基金从业资格">${escapeHtml(resume.certifications.join("\n"))}</textarea>
              </div>
            </div>
          </div>

          <div class="form-section">
            <div class="form-section-heading">
              <div>
                <h3>教育经历</h3>
                <p>保留与目标岗位相关的学历信息。</p>
              </div>
              <button class="button button-secondary button-small" type="button" data-action="add-education">
                <i data-lucide="plus"></i>
                添加教育
              </button>
            </div>
            ${resume.education.length ? `
              <div class="repeat-list">
                ${resume.education.map((item, index) => renderEducationItem(item, index)).join("")}
              </div>
            ` : emptyState("graduation-cap", "暂无教育经历，可手动添加。")}
          </div>

          <div class="form-section">
            <div class="form-section-heading">
              <div>
                <h3>工作 / 实习经历</h3>
                <p>亮点建议使用动作、方法、结果的结构描述。</p>
              </div>
              <button class="button button-secondary button-small" type="button" data-action="add-experience">
                <i data-lucide="plus"></i>
                添加经历
              </button>
            </div>
            ${resume.experience.length ? `
              <div class="repeat-list">
                ${resume.experience.map((item, index) => renderExperienceItem(item, index)).join("")}
              </div>
            ` : emptyState("briefcase-business", "暂无工作或实习经历，可手动添加。")}
          </div>

          <div class="form-section">
            <div class="form-section-heading">
              <div>
                <h3>项目经历</h3>
                <p>课程项目、竞赛项目与个人作品都可以填写。</p>
              </div>
              <button class="button button-secondary button-small" type="button" data-action="add-project">
                <i data-lucide="plus"></i>
                添加项目
              </button>
            </div>
            ${resume.projects.length ? `
              <div class="repeat-list">
                ${resume.projects.map((item, index) => renderProjectItem(item, index)).join("")}
              </div>
            ` : emptyState("folder-kanban", "暂无项目经历，可手动添加。")}
          </div>

          <div class="form-actions">
            <button class="button button-secondary" type="button" data-action="go-step" data-step="1">
              <i data-lucide="arrow-left"></i>
              返回上传
            </button>
            <button class="button button-primary" type="button" data-action="start-matching">
              开始匹配岗位
              <i data-lucide="arrow-right"></i>
            </button>
          </div>
        </section>
      </section>
    `;
  }

  function renderEducationItem(item, index) {
    return `
      <div class="repeat-item">
        <div class="repeat-item-header">
          <strong>教育经历 ${index + 1}</strong>
          <button class="icon-button danger" type="button" data-action="remove-education" data-index="${index}" title="删除教育经历" aria-label="删除教育经历">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
        <div class="form-grid four">
          ${compactField("学校", `education.${index}.school`, item.school || "", "学校名称")}
          ${compactField("学位", `education.${index}.degree`, item.degree || "", "本科 / 硕士")}
          ${compactField("专业", `education.${index}.major`, item.major || "", "专业名称")}
          ${compactField("毕业年份", `education.${index}.year`, item.year || "", "2026")}
        </div>
      </div>
    `;
  }

  function renderExperienceItem(item, index) {
    return `
      <div class="repeat-item">
        <div class="repeat-item-header">
          <strong>经历 ${index + 1}</strong>
          <button class="icon-button danger" type="button" data-action="remove-experience" data-index="${index}" title="删除经历" aria-label="删除经历">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
        <div class="form-grid">
          ${compactField("职位", `experience.${index}.title`, item.title || "", "岗位名称")}
          ${compactField("公司 / 组织", `experience.${index}.company`, item.company || "", "公司名称")}
          ${compactField("时间", `experience.${index}.duration`, item.duration || "", "2025.06-至今")}
        </div>
        <div class="form-field" style="margin-top: 12px;">
          <label for="experienceHighlights${index}">工作亮点</label>
          <textarea class="textarea" id="experienceHighlights${index}" data-bind="experience.${index}.highlights" data-lines="true" placeholder="每行填写一项">${escapeHtml((item.highlights || []).join("\n"))}</textarea>
        </div>
      </div>
    `;
  }

  function renderProjectItem(item, index) {
    return `
      <div class="repeat-item">
        <div class="repeat-item-header">
          <strong>项目 ${index + 1}</strong>
          <button class="icon-button danger" type="button" data-action="remove-project" data-index="${index}" title="删除项目" aria-label="删除项目">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
        <div class="form-grid two">
          ${compactField("项目名称", `projects.${index}.name`, item.name || "", "项目名称")}
          ${compactField("技术栈（每行一个）", `projects.${index}.technologies`, (item.technologies || []).join("\n"), "Python / React", true)}
        </div>
        <div class="form-field" style="margin-top: 12px;">
          <label for="projectDescription${index}">项目描述</label>
          <textarea class="textarea" id="projectDescription${index}" data-bind="projects.${index}.description" placeholder="项目目标、你的工作与结果">${escapeHtml(item.description || "")}</textarea>
        </div>
      </div>
    `;
  }

  function renderStep3() {
    if (state.matching) {
      return `
        <section class="page-section">
          ${sectionIntro("03", "scan-search", "岗位匹配", "Claude 正在比较你的档案与岗位要求。")}
          ${processingTemplate("scan-search", "正在分析匹配岗位", state.matchingDetail || "正在载入岗位库...")}
        </section>
      `;
    }

    if (!isApiReady()) {
      return renderBlockedStep(
        "03",
        "scan-search",
        "岗位匹配",
        "请先在左侧填写 Claude API Key，再开始岗位匹配。",
        "返回确认档案",
        2
      );
    }

    if (state.matchError) {
      return `
        <section class="page-section">
          ${sectionIntro("03", "scan-search", "岗位匹配", "Claude 根据档案与求职偏好筛选岗位。")}
          <div class="alert error">
            <i data-lucide="circle-alert"></i>
            <span>${escapeHtml(state.matchError)}</span>
          </div>
          <div class="action-row end">
            <button class="button button-secondary" type="button" data-action="go-step" data-step="2">
              <i data-lucide="arrow-left"></i>
              返回档案
            </button>
            <button class="button button-primary" type="button" data-action="retry-match">
              <i data-lucide="refresh-cw"></i>
              重新匹配
            </button>
          </div>
        </section>
      `;
    }

    if (state.matches === null) {
      scheduleMatching();
      return `
        <section class="page-section">
          ${sectionIntro("03", "scan-search", "岗位匹配", "Claude 正在比较你的档案与岗位要求。")}
          ${processingTemplate("scan-search", "准备匹配岗位", "正在读取岗位库与求职偏好...")}
        </section>
      `;
    }

    if (!state.matches.length) {
      return `
        <section class="page-section">
          ${sectionIntro("03", "scan-search", "岗位匹配", "Claude 根据档案与求职偏好筛选岗位。")}
          <div class="alert warning">
            <i data-lucide="search-x"></i>
            <span>当前条件下没有找到匹配岗位，可以返回调整偏好后重试。</span>
          </div>
          <div class="action-row">
            <button class="button button-secondary" type="button" data-action="go-step" data-step="2">
              <i data-lucide="arrow-left"></i>
              修改偏好
            </button>
            <button class="button button-primary" type="button" data-action="retry-match">
              <i data-lucide="refresh-cw"></i>
              重新匹配
            </button>
          </div>
        </section>
      `;
    }

    const scores = state.matches.map((item) => Number(item.match_score) || 0);
    const maxScore = Math.max(...scores);
    const avgScore = scores.reduce((sum, value) => sum + value, 0) / scores.length;

    return `
      <section class="page-section">
        ${sectionIntro(
          "03",
          "scan-search",
          "岗位匹配结果",
          "结果按综合匹配度排序。分数来自技能、经历、学历、地点与偏好五个维度。",
          `<button class="button button-secondary button-small" type="button" data-action="retry-match"><i data-lucide="refresh-cw"></i>重新匹配</button>`
        )}

        ${state.matchFallbackWarning ? `
          <div class="alert warning">
            <i data-lucide="filter-x"></i>
            <span>筛选条件内没有岗位，本次匹配使用了完整岗位库。</span>
          </div>
        ` : ""}

        <div class="metric-grid">
          <div class="metric"><span>匹配岗位数</span><strong>${state.matches.length}</strong></div>
          <div class="metric"><span>最高匹配分</span><strong>${maxScore.toFixed(0)}<small>/10</small></strong></div>
          <div class="metric"><span>平均匹配分</span><strong>${avgScore.toFixed(1)}<small>/10</small></strong></div>
        </div>

        <div class="results-list">
          ${state.matches.map((match, index) => renderJobCard(match, index)).join("")}
        </div>

        <div class="bottom-actions">
          <button class="button button-secondary" type="button" data-action="go-step" data-step="2">
            <i data-lucide="arrow-left"></i>
            返回修改档案
          </button>
        </div>
      </section>
    `;
  }

  function renderJobCard(match, index) {
    const job = state.jobs?.find((item) => item.job_id === match.job_id);
    if (!job) {
      return "";
    }
    const score = clamp(Number(match.match_score) || 0, 0, 10);
    const scoreClass = score < 4 ? "low" : score < 7 ? "mid" : "";
    const strengths = safeArray(match.strength_areas);
    const gaps = safeArray(match.gap_areas);

    return `
      <article class="job-card">
        <div class="job-card-head">
          <div class="job-card-title">
            <span class="score-seal ${scoreClass}">${formatScore(score)}</span>
            <div class="job-title-copy">
              <h3>${escapeHtml(job.title)}</h3>
              <p>${escapeHtml(job.company)} · ${escapeHtml(job.location)}</p>
              <div class="score-line">
                <div class="score-track"><div class="score-fill ${scoreClass}" style="width:${score * 10}%"></div></div>
                <div class="score-label"><span>综合匹配度</span><span>${formatScore(score)} / 10</span></div>
              </div>
            </div>
          </div>
          <div class="job-actions">
            <button class="button button-primary button-small" type="button" data-action="open-optimization" data-job-id="${escapeAttr(job.job_id)}">
              <i data-lucide="wand-sparkles"></i>
              优化简历
            </button>
            <span class="meta-tag">推荐 #${index + 1}</span>
          </div>
        </div>
        <div class="job-meta">
          <span class="meta-tag">${escapeHtml(job.salary_range)}</span>
          <span class="meta-tag">${escapeHtml(job.industry)}</span>
          <span class="meta-tag">${escapeHtml(job.experience_level)}</span>
          <span class="meta-tag">${escapeHtml(job.education_required)}</span>
        </div>
        <p class="job-summary">${escapeHtml(match.match_summary || "暂无匹配说明")}</p>
        <div class="analysis-grid">
          <div class="analysis-column positive">
            <h4><i data-lucide="circle-check"></i>优势领域</h4>
            ${strengths.length ? `<ul class="plain-list">${strengths.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<span class="field-hint">暂无明确优势项</span>`}
          </div>
          <div class="analysis-column warning">
            <h4><i data-lucide="circle-alert"></i>待提升</h4>
            ${gaps.length ? `<ul class="plain-list">${gaps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<span class="field-hint">暂无明确短板</span>`}
          </div>
        </div>
        <details class="detail-toggle">
          <summary>查看岗位详情</summary>
          <div class="detail-body">
            <p><strong>岗位描述</strong></p>
            <p>${escapeHtml(job.description)}</p>
            <p><strong>岗位要求</strong></p>
            <p>${escapeHtml(job.requirements)}</p>
          </div>
        </details>
      </article>
    `;
  }

  function renderStep4() {
    const job = getCurrentJob();
    const jobId = state.optimizingJobId;

    if (!job || !jobId) {
      return renderBlockedStep(
        "04",
        "wand-sparkles",
        "优化建议",
        "请先从岗位匹配结果中选择一个目标岗位。",
        "返回岗位匹配",
        3
      );
    }

    if (state.optimizing) {
      return `
        <section class="page-section">
          ${sectionIntro("04", "wand-sparkles", "简历优化建议", `正在针对「${job.title}」分析简历差距。`)}
          ${processingTemplate("wand-sparkles", "正在生成优化方案", state.optimizationDetail || "Claude 正在对照岗位要求分析你的简历...")}
        </section>
      `;
    }

    const optimization = state.optimizations[jobId];
    if (!optimization) {
      if (!isApiReady()) {
        return renderBlockedStep(
          "04",
          "wand-sparkles",
          "优化建议",
          "请先在左侧填写 Claude API Key，再生成优化方案。",
          "返回岗位匹配",
          3
        );
      }
      scheduleOptimization();
      return `
        <section class="page-section">
          ${sectionIntro("04", "wand-sparkles", "简历优化建议", `正在针对「${job.title}」分析简历差距。`)}
          ${processingTemplate("wand-sparkles", "准备生成优化方案", "正在整理目标岗位与档案信息...")}
        </section>
      `;
    }

    if (optimization._error) {
      return `
        <section class="page-section">
          ${sectionIntro("04", "wand-sparkles", "简历优化建议", `目标岗位：${job.title} @ ${job.company}`)}
          <div class="alert error">
            <i data-lucide="circle-alert"></i>
            <span>${escapeHtml(optimization._error)}</span>
          </div>
          <div class="action-row">
            <button class="button button-secondary" type="button" data-action="go-step" data-step="3">
              <i data-lucide="arrow-left"></i>
              返回匹配结果
            </button>
            <button class="button button-primary" type="button" data-action="retry-optimization">
              <i data-lucide="refresh-cw"></i>
              重新分析
            </button>
          </div>
        </section>
      `;
    }

    const score = clamp(Number(optimization.overall_fit_score) || 0, 0, 100);
    const gaps = [...safeArray(optimization.gap_analysis)].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    const edits = safeArray(optimization.resume_optimizations);
    const keywords = safeArray(optimization.keyword_strategy).map(String);
    const coverTips = safeArray(optimization.cover_letter_tips).map(String);
    const interviewPreps = safeArray(optimization.interview_prep).map(String);

    return `
      <section class="page-section">
        ${sectionIntro(
          "04",
          "wand-sparkles",
          "简历优化建议",
          "建议只采纳与真实经历一致的内容，避免在简历中加入无法解释的信息。",
          `<button class="button button-secondary button-small" type="button" data-action="download-report"><i data-lucide="download"></i>下载报告</button>`
        )}

        <div class="optimization-layout">
          <aside class="fit-score-card">
            <div class="fit-ring" style="--score:${score}"><strong>${score}</strong></div>
            <span>综合匹配分 / 100</span>
          </aside>
          <div class="optimization-main">
            <div class="target-job">
              <h3>${escapeHtml(job.title)}</h3>
              <p>${escapeHtml(job.company)} · ${escapeHtml(job.location)} · ${escapeHtml(job.salary_range)}</p>
            </div>
            <div class="content-block">
              <div class="content-block-head">
                <div>
                  <h3>差距分析</h3>
                  <p>按严重程度排序。</p>
                </div>
              </div>
              ${gaps.length ? `
                <div class="gap-list">
                  ${gaps.map((gap) => renderGapItem(gap)).join("")}
                </div>
              ` : `<div class="empty-state">${icon("circle-check")}暂无明确差距项。</div>`}
            </div>
          </div>
        </div>

        <div class="content-block">
          <div class="content-block-head">
            <div>
              <h3>简历修改建议</h3>
              <p>对照原文与建议文本，可直接复制采用。</p>
            </div>
          </div>
          ${edits.length ? `
            <div class="optimization-list">
              ${edits.map((edit, index) => renderOptimizationItem(edit, index)).join("")}
            </div>
          ` : `<div class="empty-state">${icon("file-pen-line")}暂无简历修改建议。</div>`}
        </div>

        <div class="content-block">
          <div class="content-block-head">
            <div>
              <h3>关键词策略</h3>
              <p>自然融入简历与求职材料，避免堆砌。</p>
            </div>
          </div>
          ${keywords.length ? `<div class="keyword-list">${keywords.map((keyword) => `<span class="keyword">${escapeHtml(keyword)}</span>`).join("")}</div>` : `<div class="empty-state">${icon("tags")}暂无关键词建议。</div>`}
        </div>

        <div class="form-grid two">
          <div class="content-block">
            <div class="content-block-head">
              <div>
                <h3>求职信建议</h3>
                <p>让表达更贴近目标岗位。</p>
              </div>
            </div>
            ${coverTips.length ? `<ol class="tip-list">${coverTips.map((tip) => `<li>${escapeHtml(tip)}</li>`).join("")}</ol>` : `<div class="empty-state">${icon("mail")}暂无求职信建议。</div>`}
          </div>
          <div class="content-block">
            <div class="content-block-head">
              <div>
                <h3>面试准备</h3>
                <p>围绕岗位要求提前准备案例。</p>
              </div>
            </div>
            ${interviewPreps.length ? `<ol class="tip-list">${interviewPreps.map((tip) => `<li>${escapeHtml(tip)}</li>`).join("")}</ol>` : `<div class="empty-state">${icon("messages-square")}暂无面试准备建议。</div>`}
          </div>
        </div>

        <div class="bottom-actions">
          <button class="button button-secondary" type="button" data-action="go-step" data-step="3">
            <i data-lucide="arrow-left"></i>
            返回匹配结果
          </button>
          <div class="bottom-actions-group">
            <button class="button button-secondary" type="button" data-action="download-report">
              <i data-lucide="download"></i>
              下载 Markdown 报告
            </button>
            <button class="button button-ghost" type="button" data-action="reset-workflow">
              <i data-lucide="rotate-ccw"></i>
              重新开始
            </button>
          </div>
        </div>
      </section>
    `;
  }

  function renderGapItem(gap) {
    const severity = ["high", "medium", "low"].includes(gap.severity) ? gap.severity : "medium";
    const label = { high: "高优先级", medium: "中优先级", low: "低优先级" }[severity];
    return `
      <details class="gap-item" ${severity === "high" ? "open" : ""}>
        <summary>
          <span class="severity ${severity}">${label}</span>
          <span>${escapeHtml(gap.area || "匹配差距")} · ${escapeHtml(truncate(gap.gap_description || "", 56))}</span>
        </summary>
        <div class="gap-body">
          <p><strong>问题</strong> ${escapeHtml(gap.gap_description || "")}</p>
          <p><strong>建议</strong> ${escapeHtml(gap.suggestion || "")}</p>
        </div>
      </details>
    `;
  }

  function renderOptimizationItem(edit, index) {
    const actionLabels = {
      rewrite: "重写",
      add: "新增",
      remove: "删除",
      reorder: "调整顺序",
      highlight: "突出展示"
    };
    const action = actionLabels[edit.action] || edit.action || "修改";
    return `
      <details class="optimization-item" ${index < 3 ? "open" : ""}>
        <summary>
          <span class="meta-tag">${escapeHtml(action)}</span>
          <span>${escapeHtml(edit.section || "简历内容")}</span>
        </summary>
        <div class="optimization-body">
          <div class="edit-compare">
            <div class="edit-box">
              <span>原文</span>
              <pre>${escapeHtml(edit.original_text || "（新增内容，无原文）")}</pre>
            </div>
            <div class="edit-box suggested">
              <span>建议修改</span>
              <pre>${escapeHtml(edit.suggested_text || "")}</pre>
            </div>
          </div>
          <p><strong>修改理由</strong> ${escapeHtml(edit.rationale || "")}</p>
          <div class="action-row end">
            <button class="button button-secondary button-small" type="button" data-action="copy-suggestion" data-index="${index}">
              <i data-lucide="copy"></i>
              复制建议
            </button>
          </div>
        </div>
      </details>
    `;
  }

  function renderBlockedStep(step, iconName, title, message, buttonLabel, buttonStep) {
    return `
      <section class="page-section">
        ${sectionIntro(step, iconName, title, message)}
        <div class="alert warning">
          <i data-lucide="triangle-alert"></i>
          <span>${escapeHtml(message)}</span>
        </div>
        <div class="action-row end">
          <button class="button button-secondary" type="button" data-action="go-step" data-step="${buttonStep}">
            <i data-lucide="arrow-left"></i>
            ${escapeHtml(buttonLabel)}
          </button>
        </div>
      </section>
    `;
  }

  function sectionIntro(step, iconName, title, description, aside = "") {
    return `
      <header class="section-intro">
        <div class="section-intro-copy">
          <span class="section-kicker">${icon(iconName)}步骤 ${step}</span>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(description)}</p>
        </div>
        ${aside}
      </header>
    `;
  }

  function processingTemplate(iconName, title, detail) {
    return `
      <div class="processing-panel">
        <div class="processing-visual">${icon(iconName)}</div>
        <h2>${escapeHtml(title)}</h2>
        <p id="processingDetail">${escapeHtml(detail)}</p>
      </div>
    `;
  }

  function formField(label, path, value, type, placeholder) {
    const id = `field-${path.replaceAll(".", "-")}`;
    return `
      <div class="form-field">
        <label for="${id}">${escapeHtml(label)}</label>
        <input class="input" id="${id}" type="${type}" data-bind="${escapeAttr(path)}" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}">
      </div>
    `;
  }

  function compactField(label, path, value, placeholder, multiline = false) {
    const id = `field-${path.replaceAll(".", "-")}`;
    if (multiline) {
      return `
        <div class="form-field">
          <label for="${id}">${escapeHtml(label)}</label>
          <textarea class="textarea" id="${id}" data-bind="${escapeAttr(path)}" data-lines="true" placeholder="${escapeAttr(placeholder)}">${escapeHtml(value)}</textarea>
        </div>
      `;
    }
    return `
      <div class="form-field">
        <label for="${id}">${escapeHtml(label)}</label>
        <input class="input" id="${id}" type="text" data-bind="${escapeAttr(path)}" value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}">
      </div>
    `;
  }

  function optionSelect(value, selected) {
    return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value)}</option>`;
  }

  function emptyState(iconName, text) {
    return `<div class="empty-state">${icon(iconName)}<span>${escapeHtml(text)}</span></div>`;
  }

  function icon(name) {
    return `<i data-lucide="${escapeAttr(name)}"></i>`;
  }

  function setResumeFile(file) {
    const ext = file.name.toLowerCase().split(".").pop();
    if (!["pdf", "docx"].includes(ext)) {
      showToast("仅支持 PDF 和 DOCX 文件。", "error");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      showToast("文件超过 10 MB，请压缩后再试。", "error");
      return;
    }
    state.resumeFile = file;
    state.resumeWarning = "";
    render();
  }

  async function startParsing() {
    if (!state.resumeFile) {
      showToast("请先选择简历文件。", "warning");
      return;
    }
    if (!isApiReady()) {
      showToast("请先填写 Claude API Key。", "warning");
      return;
    }

    state.busy = {
      type: "parse",
      title: "正在读取简历",
      detail: "文件只在浏览器内解析，正在提取可编辑文本..."
    };
    render();

    try {
      const extracted = await extractTextFromFile(state.resumeFile);
      state.resumeText = extracted.text;
      state.resumeWarning = extracted.warning || "";

      if (!state.resumeText.trim()) {
        throw new Error("未能从文件中提取到文本，请上传可编辑的 PDF 或 DOCX。");
      }

      state.busy.title = "Claude 正在分析简历";
      state.busy.detail = "正在识别基本信息、技能、教育与项目经历...";
      render();

      const structured = await extractResume(state.resumeText);
      if (structured._error) {
        throw new Error(structured._error);
      }

      state.structuredResume = normalizeResume(structured);
      state.matches = null;
      state.matchError = "";
      state.maxStep = Math.max(state.maxStep, 2);
      state.step = 2;
      showToast(state.resumeWarning || "简历解析完成，请确认提取结果。", state.resumeWarning ? "warning" : "success");
    } catch (error) {
      showToast(humanError(error), "error");
    } finally {
      state.busy = null;
      render();
    }
  }

  async function extractTextFromFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    if (file.name.toLowerCase().endsWith(".pdf")) {
      if (!window.pdfjsLib) {
        throw new Error("PDF 解析组件加载失败，请检查网络后刷新页面。");
      }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
      const pages = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        let pageText = "";
        for (const item of content.items) {
          pageText += item.str || "";
          pageText += item.hasEOL ? "\n" : " ";
        }
        pages.push(pageText.trim());
      }
      const text = pages.filter(Boolean).join("\n\n").trim();
      return {
        text,
        warning: text.length < 50
          ? "提取到的文本较少，可能是扫描版 PDF；请核对后续档案是否完整。"
          : ""
      };
    }

    if (!window.mammoth) {
      throw new Error("DOCX 解析组件加载失败，请检查网络后刷新页面。");
    }
    const result = await window.mammoth.extractRawText({ arrayBuffer });
    const text = (result.value || "").trim();
    return {
      text,
      warning: text.length < 50 ? "提取到的文本较少，请核对后续档案是否完整。" : ""
    };
  }

  async function extractResume(resumeText) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const prefix = attempt === 0
          ? ""
          : "你上次的回复不是有效的 JSON。请仅输出 JSON 对象，不要包含任何其他文字。\n\n---\n\n";
        const responseText = await callClaude({
          system: RESUME_SYSTEM_PROMPT,
          maxTokens: 2000,
          temperature: 0.1,
          messages: [{
            role: "user",
            content: `${prefix}请从以下简历文本中提取结构化信息：\n\n---\n${resumeText}\n---`
          }]
        });
        const data = parseJsonResponse(responseText);
        return {
          name: data.name ?? null,
          email: data.email ?? null,
          phone: data.phone ?? null,
          skills: safeArray(data.skills),
          experience: safeArray(data.experience),
          education: safeArray(data.education),
          projects: safeArray(data.projects),
          languages: safeArray(data.languages),
          certifications: safeArray(data.certifications)
        };
      } catch (error) {
        lastError = error;
      }
    }
    return emptyResume(`简历解析失败：${humanError(lastError)}`);
  }

  async function callClaude({ system, messages, maxTokens, temperature }) {
    if (!isApiReady()) {
      throw new Error("请先填写 Claude API Key。");
    }

    let response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": state.apiKey.trim(),
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          max_tokens: maxTokens,
          temperature,
          system,
          messages
        })
      });
    } catch (error) {
      throw new Error(`无法连接 Claude API：${humanError(error)}`);
    }

    if (!response.ok) {
      let message = `Claude API 请求失败（HTTP ${response.status}）`;
      try {
        const payload = await response.json();
        if (payload?.error?.message) {
          message = payload.error.message;
        }
      } catch {
        // Keep the status-based fallback message.
      }
      throw new Error(message);
    }

    const data = await response.json();
    const text = safeArray(data.content)
      .filter((block) => block?.type === "text")
      .map((block) => block.text || "")
      .join("\n")
      .trim();
    if (!text) {
      throw new Error("Claude 返回了空响应。");
    }
    return text;
  }

  function scheduleMatching() {
    if (state.matchScheduled || state.matching) {
      return;
    }
    state.matchScheduled = true;
    window.setTimeout(() => {
      state.matchScheduled = false;
      startMatching();
    }, 40);
  }

  async function startMatching() {
    if (state.matching || !isApiReady()) {
      return;
    }
    if (!state.structuredResume) {
      state.matchError = "请先解析并确认简历。";
      render();
      return;
    }

    state.matching = true;
    state.matchError = "";
    state.matchFallbackWarning = false;
    state.matchingDetail = "正在载入岗位库...";
    render();

    try {
      const jobs = await loadJobs();
      let filtered = filterJobs(jobs, state.preferences);
      if (!filtered.length) {
        filtered = jobs;
        state.matchFallbackWarning = true;
      }

      const summaries = filtered.map(toJobSummary);
      let matches;
      if (summaries.length <= MAX_JOBS_PER_BATCH) {
        state.matchingDetail = `正在比较 ${summaries.length} 个岗位...`;
        render();
        matches = await matchBatch(state.structuredResume, summaries, state.preferences, Math.min(DEFAULT_TOP_K, summaries.length));
      } else {
        const batches = chunk(summaries, MAX_JOBS_PER_BATCH);
        const perBatch = Math.min(6, DEFAULT_TOP_K);
        const winners = [];
        const seen = new Set();

        for (let index = 0; index < batches.length; index += 1) {
          state.matchingDetail = `正在分析第 ${index + 1} / ${batches.length} 批岗位...`;
          render();
          const results = await matchBatch(
            state.structuredResume,
            batches[index],
            state.preferences,
            Math.min(perBatch, batches[index].length)
          );
          for (const match of results) {
            if (match?.job_id && !seen.has(match.job_id)) {
              seen.add(match.job_id);
              winners.push(match);
            }
          }
        }

        if (winners.length <= DEFAULT_TOP_K) {
          matches = winners.sort((a, b) => Number(b.match_score || 0) - Number(a.match_score || 0));
        } else {
          state.matchingDetail = "正在对候选岗位进行最终排序...";
          render();
          const winnerIds = new Set(winners.map((item) => item.job_id));
          const finalJobs = summaries.filter((job) => winnerIds.has(job.job_id));
          try {
            matches = await matchBatch(
              state.structuredResume,
              finalJobs,
              state.preferences,
              Math.min(DEFAULT_TOP_K, finalJobs.length)
            );
          } catch {
            matches = winners
              .sort((a, b) => Number(b.match_score || 0) - Number(a.match_score || 0))
              .slice(0, DEFAULT_TOP_K);
          }
        }
      }

      state.matches = safeArray(matches)
        .filter((match) => match?.job_id)
        .map((match) => ({
          ...match,
          match_score: clamp(Number(match.match_score) || 0, 0, 10),
          strength_areas: safeArray(match.strength_areas),
          gap_areas: safeArray(match.gap_areas)
        }));

      if (!state.matches.length) {
        state.matchError = "Claude 没有返回可用匹配结果，请重试。";
      } else if (state.matchFallbackWarning) {
        showToast("筛选条件内没有岗位，本次使用了完整岗位库。", "warning");
      }
    } catch (error) {
      state.matchError = humanError(error);
      showToast(state.matchError, "error");
    } finally {
      state.matching = false;
      state.matchingDetail = "";
      render();
    }
  }

  async function matchBatch(resume, jobs, preferences, topK) {
    const system = MATCH_SYSTEM_PROMPT.replaceAll("{top_k}", String(topK));
    const userMessage = `候选人档案：
${JSON.stringify(resume, null, 2)}

候选人偏好：
- 意向行业：${preferences.industries.length ? preferences.industries.join("、") : "不限"}
- 意向地点：${preferences.locations.length ? preferences.locations.join("、") : "不限"}
- 最低薪资：${preferences.salary_min || "面议"}
- 经验水平：${preferences.experience_level || "不限"}
- 岗位类型：${preferences.job_type || "全职"}

可投递岗位：
${JSON.stringify(jobs, null, 2)}

请找出最合适的 ${topK} 个匹配岗位并返回 JSON 结果。`;

    const responseText = await callClaude({
      system,
      maxTokens: 3000,
      temperature: 0.2,
      messages: [{ role: "user", content: userMessage }]
    });
    const data = parseJsonResponse(responseText);
    return safeArray(data.matches);
  }

  function openOptimization(jobId) {
    const job = state.jobs?.find((item) => item.job_id === jobId);
    if (!job) {
      showToast("未找到目标岗位，请重新匹配。", "error");
      return;
    }
    state.optimizingJobId = jobId;
    state.optimizations[jobId] = null;
    state.optimizationScheduled = false;
    state.maxStep = Math.max(state.maxStep, 4);
    state.step = 4;
    closeSidebar();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function scheduleOptimization() {
    if (state.optimizationScheduled || state.optimizing) {
      return;
    }
    state.optimizationScheduled = true;
    window.setTimeout(() => {
      state.optimizationScheduled = false;
      startOptimization();
    }, 40);
  }

  async function startOptimization() {
    const job = getCurrentJob();
    const jobId = state.optimizingJobId;
    if (!job || !jobId || state.optimizing || !isApiReady()) {
      return;
    }

    state.optimizing = true;
    state.optimizationDetail = "正在对照岗位要求分析简历...";
    render();

    try {
      const result = await optimizeResume(state.structuredResume, job);
      state.optimizations[jobId] = result;
    } catch (error) {
      state.optimizations[jobId] = {
        _error: humanError(error),
        overall_fit_score: 0
      };
      showToast(humanError(error), "error");
    } finally {
      state.optimizing = false;
      state.optimizationDetail = "";
      render();
    }
  }

  async function optimizeResume(resume, job) {
    const jobPayload = {
      job_id: job.job_id,
      title: job.title,
      company: job.company,
      industry: job.industry,
      location: job.location,
      experience_level: job.experience_level,
      education_required: job.education_required,
      description: job.description,
      requirements: job.requirements
    };
    const responseText = await callClaude({
      system: OPTIMIZE_SYSTEM_PROMPT,
      maxTokens: 4000,
      temperature: 0.4,
      messages: [{
        role: "user",
        content: `目标岗位：
${JSON.stringify(jobPayload, null, 2)}

候选人当前简历：
${JSON.stringify(resume, null, 2)}

请分析匹配度并提供优化建议。`
      }]
    });
    return parseJsonResponse(responseText);
  }

  function parseJsonResponse(text) {
    let source = String(text || "").trim();
    source = source.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    try {
      return JSON.parse(source);
    } catch {
      const start = source.indexOf("{");
      const end = source.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(source.slice(start, end + 1));
      }
      throw new Error("AI 返回内容不是有效的 JSON。");
    }
  }

  async function loadJobs() {
    if (state.jobs) {
      return state.jobs;
    }
    if (!state.jobsPromise) {
      state.jobsPromise = fetch("data/jobs.json", { cache: "no-cache" })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`岗位库载入失败（HTTP ${response.status}）`);
          }
          return response.json();
        })
        .then((jobs) => {
          if (!Array.isArray(jobs) || !jobs.length) {
            throw new Error("岗位库为空或格式不正确。");
          }
          state.jobs = jobs;
          return jobs;
        })
        .catch((error) => {
          state.jobsPromise = null;
          throw error;
        });
    }
    return state.jobsPromise;
  }

  function filterJobs(jobs, preferences) {
    return jobs.filter((job) => {
      if (preferences.industries.length && !preferences.industries.includes(job.industry)) {
        return false;
      }
      if (preferences.locations.length && !preferences.locations.includes(job.location)) {
        return false;
      }
      if (preferences.experience_level !== "不限" && preferences.experience_level !== job.experience_level) {
        return false;
      }
      return true;
    });
  }

  function toJobSummary(job) {
    return {
      job_id: job.job_id,
      title: job.title,
      company: job.company,
      industry: job.industry,
      location: job.location,
      experience_level: job.experience_level,
      education_required: job.education_required,
      salary_range: job.salary_range,
      description: job.description,
      requirements: job.requirements
    };
  }

  function getCurrentJob() {
    if (!state.optimizingJobId || !state.jobs) {
      return null;
    }
    return state.jobs.find((job) => job.job_id === state.optimizingJobId) || null;
  }

  function normalizeResume(data) {
    const normalizeEntry = (entry, type) => {
      const item = entry && typeof entry === "object" ? entry : {};
      if (type === "education") {
        return {
          degree: stringValue(item.degree),
          school: stringValue(item.school),
          major: stringValue(item.major),
          year: stringValue(item.year)
        };
      }
      if (type === "experience") {
        return {
          title: stringValue(item.title),
          company: stringValue(item.company),
          duration: stringValue(item.duration),
          highlights: safeArray(item.highlights).map(String).filter(Boolean)
        };
      }
      return {
        name: stringValue(item.name),
        description: stringValue(item.description),
        technologies: safeArray(item.technologies).map(String).filter(Boolean)
      };
    };

    return {
      name: data.name ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      skills: safeArray(data.skills).map(String).filter(Boolean),
      experience: safeArray(data.experience).map((item) => normalizeEntry(item, "experience")),
      education: safeArray(data.education).map((item) => normalizeEntry(item, "education")),
      projects: safeArray(data.projects).map((item) => normalizeEntry(item, "project")),
      languages: safeArray(data.languages).map(String).filter(Boolean),
      certifications: safeArray(data.certifications).map(String).filter(Boolean)
    };
  }

  function emptyResume(error) {
    return {
      name: null,
      email: null,
      phone: null,
      skills: [],
      experience: [],
      education: [],
      projects: [],
      languages: [],
      certifications: [],
      _error: error
    };
  }

  function setPath(object, path, value) {
    const parts = path.split(".");
    let cursor = object;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      if (cursor[part] === undefined || cursor[part] === null) {
        cursor[part] = {};
      }
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
  }

  function toggleChip(group, value, button) {
    const values = state.preferences[group];
    if (!Array.isArray(values)) {
      return;
    }
    const index = values.indexOf(value);
    if (index >= 0) {
      values.splice(index, 1);
    } else {
      values.push(value);
    }
    const active = values.includes(value);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.innerHTML = `${active ? '<i data-lucide="check"></i>' : ""}${escapeHtml(value)}`;
    refreshIcons();
    invalidateMatches();
  }

  function invalidateMatches() {
    state.matches = null;
    state.matchError = "";
    state.matchFallbackWarning = false;
    state.optimizations = {};
    state.optimizingJobId = null;
    state.maxStep = Math.min(state.maxStep, 2);
  }

  function canNavigate(step) {
    if (step > state.maxStep) {
      return false;
    }
    if (step === 3 && !state.structuredResume) {
      return false;
    }
    if (step === 4 && !state.optimizingJobId) {
      return false;
    }
    return true;
  }

  function goToStep(step) {
    if (!canNavigate(step)) {
      return;
    }
    state.step = step;
    closeSidebar();
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetWorkflow() {
    const hasProgress = state.step > 1 || state.resumeFile || state.structuredResume;
    if (hasProgress && !window.confirm("确定要重新开始吗？当前简历与匹配结果将被清除。")) {
      return;
    }

    state.step = 1;
    state.maxStep = 1;
    state.resumeFile = null;
    state.resumeText = "";
    state.resumeWarning = "";
    state.structuredResume = null;
    state.matches = null;
    state.matchError = "";
    state.matchFallbackWarning = false;
    state.matching = false;
    state.matchScheduled = false;
    state.optimizingJobId = null;
    state.optimizations = {};
    state.optimizing = false;
    state.optimizationScheduled = false;
    state.busy = null;
    state.preferences = {
      industries: [],
      locations: [],
      salary_min: "面议",
      experience_level: "不限",
      job_type: "全职"
    };
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    showToast("已开始新的求职工作流。", "info");
  }

  function downloadReport() {
    const job = getCurrentJob();
    const optimization = state.optimizations[state.optimizingJobId];
    if (!job || !optimization || optimization._error) {
      showToast("暂无可下载的优化报告。", "warning");
      return;
    }
    const markdown = generateReport(job, optimization);
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `简历优化报告_${safeFilename(job.title)}_${safeFilename(job.company)}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("优化报告已下载。", "success");
  }

  function generateReport(job, optimization) {
    const lines = [
      "# 简历优化报告",
      "",
      `**目标岗位**：${job.title} @ ${job.company}`,
      `**地点**：${job.location} | **薪资**：${job.salary_range}`,
      `**综合匹配分**：${optimization.overall_fit_score ?? "N/A"}/100`,
      "",
      "---",
      "",
      "## 差距分析"
    ];

    for (const gap of safeArray(optimization.gap_analysis)) {
      const severity = { high: "高", medium: "中", low: "低" }[gap.severity] || gap.severity || "";
      lines.push(`- **【${severity}】${gap.area || ""}**：${gap.gap_description || ""}`);
      lines.push(`  - 建议：${gap.suggestion || ""}`);
    }

    lines.push("", "---", "", "## 简历修改建议");
    for (const edit of safeArray(optimization.resume_optimizations)) {
      lines.push(`### ${edit.section || ""}`);
      lines.push(`- **操作**：${edit.action || ""}`);
      if (edit.original_text) {
        lines.push(`- **原文**：${edit.original_text}`);
      }
      lines.push(`- **建议**：${edit.suggested_text || ""}`);
      lines.push(`- **理由**：${edit.rationale || ""}`);
    }

    lines.push("", "---", "", "## 关键词策略");
    for (const keyword of safeArray(optimization.keyword_strategy)) {
      lines.push(`- ${keyword}`);
    }

    lines.push("", "---", "", "## 求职信建议");
    for (const tip of safeArray(optimization.cover_letter_tips)) {
      lines.push(`- ${tip}`);
    }

    lines.push("", "---", "", "## 面试准备");
    for (const question of safeArray(optimization.interview_prep)) {
      lines.push(`- ${question}`);
    }

    lines.push("", "---", "", "*本报告由 AI 生成，仅供参考。*");
    return lines.join("\n");
  }

  async function copySuggestion(index) {
    const optimization = state.optimizations[state.optimizingJobId];
    const edit = safeArray(optimization?.resume_optimizations)[index];
    if (!edit?.suggested_text) {
      showToast("没有可复制的建议文本。", "warning");
      return;
    }
    try {
      await copyToClipboard(edit.suggested_text);
      showToast("建议文本已复制。", "success");
    } catch {
      showToast("复制失败，请手动选择文本。", "error");
    }
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) {
      throw new Error("Copy failed");
    }
  }

  function showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    const iconName = type === "error"
      ? "circle-alert"
      : type === "warning"
        ? "triangle-alert"
        : type === "success"
          ? "circle-check"
          : "info";
    toast.innerHTML = `${icon(iconName)}<span>${escapeHtml(message)}</span>`;
    els.toastStack.appendChild(toast);
    refreshIcons();
    window.setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(6px)";
      window.setTimeout(() => toast.remove(), 180);
    }, 4200);
  }

  function refreshIcons() {
    if (window.lucide?.createIcons) {
      window.lucide.createIcons({
        attrs: {
          "stroke-width": 1.8,
          "aria-hidden": "true"
        }
      });
    }
  }

  function persistApiKey() {
    try {
      if (state.apiKey) {
        sessionStorage.setItem(API_KEY_STORAGE, state.apiKey);
      } else {
        sessionStorage.removeItem(API_KEY_STORAGE);
      }
    } catch {
      // Session storage can be unavailable in strict privacy modes.
    }
  }

  function isApiReady() {
    return Boolean(state.apiKey.trim());
  }

  function openSidebar() {
    document.body.classList.add("sidebar-open");
  }

  function closeSidebar() {
    document.body.classList.remove("sidebar-open");
  }

  function chunk(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function stringValue(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatScore(score) {
    return Number.isInteger(score) ? String(score) : score.toFixed(1);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function severityRank(severity) {
    return { high: 0, medium: 1, low: 2 }[severity] ?? 3;
  }

  function truncate(text, length) {
    const value = String(text || "");
    return value.length > length ? `${value.slice(0, length)}...` : value;
  }

  function safeFilename(value) {
    return String(value || "报告").replace(/[\\/:*?"<>|]/g, "_");
  }

  function humanError(error) {
    if (!error) {
      return "未知错误";
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
      return "网络请求失败，请检查网络连接后重试。";
    }
    if (/401|invalid x-api-key|authentication/i.test(message)) {
      return "API Key 无效或已过期，请检查后重试。";
    }
    if (/429|rate limit/i.test(message)) {
      return "请求过于频繁，请稍后再试。";
    }
    return message || "请求失败，请重试。";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
