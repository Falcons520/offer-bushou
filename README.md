# Offer 捕手

Offer 捕手是一个静态 AI 求职工作台，帮助用户解析简历、匹配岗位并生成针对目标岗位的简历优化建议。

线上地址：<https://falcons520.github.io/offer-bushou/>

## 当前版本

- 无需 Python、服务器或数据库，直接由 GitHub Pages 托管。
- PDF 和 DOCX 在浏览器内提取文本，文件本身不会上传到服务器。
- 使用 Claude API 完成简历结构化、岗位语义匹配和简历优化。
- 内置 80 个中文岗位，覆盖互联网、金融、咨询、消费、制造、医疗、教育和能源行业。
- 支持四步向导、岗位筛选、分批匹配、原文与建议文对照、Markdown 报告下载。
- 桌面与移动端自适应，不需要构建步骤。

## 使用方式

1. 打开线上地址。
2. 在左侧填写自己的 Anthropic API Key。
3. 上传 PDF 或 DOCX 简历，选择求职偏好。
4. 解析并校对简历档案。
5. 查看匹配岗位，选择目标岗位生成优化报告。

API Key 仅写入当前标签页的 `sessionStorage`，关闭标签页后自动清除。应用不使用后端代管密钥。

## 本地预览

项目是纯静态站点，但浏览器需要通过 HTTP 读取岗位 JSON，因此请使用任意静态服务器：

```powershell
python -m http.server 4173
```

然后访问 `http://127.0.0.1:4173/`。

## GitHub Pages 发布

GitHub Pages 直接从 `master` 分支根目录发布：

1. 打开 GitHub 仓库的 `Settings > Pages`。
2. 在 `Build and deployment` 中选择 `Deploy from a branch`。
3. 分支选择 `master`，目录选择 `/ (root)`。
4. 保存后等待 Pages 完成首次构建。

后续每次推送到 `master` 都会自动更新线上站点。

## 文件结构

```text
.
├── index.html
├── .nojekyll
├── assets/
│   ├── app.js
│   └── styles.css
├── data/
│   └── jobs.json
├── SOLUTION.md
└── README.md
```

岗位数据位于 `data/jobs.json`。新增或修改岗位后直接提交即可。

## 浏览器依赖

页面通过 CDN 加载 PDF.js、Mammoth.js 和 Lucide 图标。Claude API 请求由浏览器直接发送到 Anthropic，需要网络可访问 `api.anthropic.com`。

## 隐私与限制

- 简历解析在浏览器内完成，原始文件不会上传。
- 简历文本和结构化档案会随请求发送给 Anthropic，用于生成 AI 结果。
- 静态应用无法隐藏 API Key，因此只应使用自己的密钥，并避免在公共设备上保存。
- AI 输出仅作求职辅助，提交前应核对事实并确认内容可被本人解释。
