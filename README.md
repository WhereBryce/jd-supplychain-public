# jd-supplychain-public

JD 供应链团队知识库的**对外发布站**（GitHub Pages 托管）。所有网页在此维护，通过下面的门户统一导航。

🌐 **发布站根地址**：<https://wherebryce.github.io/jd-supplychain-public/>

## 🧭 网页导航

| 页面 | 类型 | 说明 | 链接 |
|---|---|---|---|
| 门户首页 | 导航 | 所有页面的总入口（页面目录） | <https://wherebryce.github.io/jd-supplychain-public/> |
| 团队知识库使用指南 | 指南 | 怎么往 Inbox 贡献材料、云⇄本地运转方式、AI 协作触 发词（含二维码） | <https://wherebryce.github.io/jd-supplychain-public/pages/guide.html> |
| 仓配费节降通用框架 | 洞察·仓配成本 | 仓配费 = 非异常+异常，按 费项→方式→抓手  三层拆解的跨品类节降骨架（含流程图） | <https://wherebryce.github.io/jd-supplychain-public/pages/warehouse-cost-reduction.html> |
| JD 仓网入门 | 新人·仓网 | 11 大 RDC、三层级 8→62 仓、RDC vs 配送中心、库存流转、布货决策、枢纽仓与常见坑（含流程图） | <https://wherebryce.github.io/jd-supplychain-public/pages/warehouse-network-primer.html> |
| JD 库存报告字段词典 | 参考·库存字段 | 商智库存报告全字段逐条识别（现货/可用/可订购公式、滞销库龄、出库销量口径、PV现货率），带即时筛选 | <https://wherebryce.github.io/jd-supplychain-public/pages/jd-inventory-report-fields.html> |
| RDC 库存查询 | 工具·加密访问 | 输入完整 SKU 后只下载对应 AES-GCM 加密分片，再按 RDC、品牌、状态查询及分页汇总 | <https://wherebryce.github.io/jd-supplychain-public/pages/rdc-inventory-query.html> |

## 📁 目录结构

```text
jd-supplychain-public/          # Pages 从 /(root) 发布
  index.html                    # 门户首页（页面目录·唯一总入口）
  pages/                        # 除入口外的所有页面集中在此
    guide.html                  # 团队知识库使用指南
    warehouse-cost-reduction.html   # 仓配费节降通用框架
    warehouse-network-primer.html   # JD 仓网入门（新人向）
    jd-inventory-report-fields.html # JD 库存报告字段词典
    rdc-inventory-query.html        # RDC 库存加密查询
  assets/
    rdc-inventory-query.css         # 查询页样式
    rdc-inventory-query.js          # 浏览器解密与查询逻辑
  data/
    rdc-inventory.enc.json          # AES-GCM 加密库存（无明文）
    rdc-inventory-shards/           # 64 个按 SKU 哈希拆分的加密查询分片
  scripts/
    build-rdc-inventory.py          # 从 RDC 报告生成加密库存
    build-rdc-inventory.ps1         # Windows 一键构建入口
    publish-rdc-inventory.ps1       # 检测更新、生成密文并推送
    run-rdc-publication.ps1         # 计划任务日志入口
    setup-rdc-publication.ps1       # DPAPI 密码及计划任务初始化
  .nojekyll                     # 关闭 Jekyll 处理
  README.md
```

## 🔐 更新 RDC 加密库存

GitHub Pages 是纯静态托管，不能运行服务端密码认证。本站采用以下方式保护库存：

1. 定时下载任务成功后覆盖最新的 `RDC库存报告.xlsx`。
2. 发布任务检测源 Excel 是否比 Pages 密文更新；未更新时直接跳过。
3. 在本机提取查询字段，按文本字典 + 行数组整理 16 万级明细，并在加密前使用 Gzip 压缩。
4. 按 SHA-256(SKU) 拆成 64 个独立 AES-GCM 分片；页面只下载当前 SKU 对应的约 36–49 KB 文件。
5. 使用 PBKDF2-SHA256（600,000 次）从访问密码派生密钥。
6. 使用 AES-256-GCM 加密完整库存和查询分片，只提交密文。
7. 浏览器输入密码后在本地解密；密码不会上传或写入仓库。

浏览器会显示分片下载进度，并通过 ETag 复用未变化的本地缓存。输入完整 SKU 后，可在该 SKU 的结果中继续筛选 RDC、品牌和库存状态。

页面中的“报告日期”来自最新一次**成功下载并发布**的 RDC 报告。若京东报表仍在生成或下载失败，网站继续保留上一份可用密文，并明确显示其报告日期，不会发布半成品。

### 首次启用自动发布

在当前 Windows 用户下运行一次：

```powershell
cd C:\Users\yao.q.1\repos\jd-supplychain-public
.\scripts\setup-rdc-publication.ps1
```

脚本会在终端中要求输入并确认访问密码。密码通过 Windows DPAPI 加密后保存到 `%LOCALAPPDATA%\JD-SupplyChain\rdc-pages-password.xml`，不会进入 Git、脚本参数或日志；该文件只能由当前 Windows 用户解密。

初始化同时注册 `JD-RDC-Pages-Publish` 计划任务：

- 每天 `11:15`：检查上午下载后的报告。
- 每天 `18:15`：检查下午下载后的报告。
- 电脑错过执行时间时，登录后补跑。
- 只提交加密数据文件；若仓库有其他未提交修改则停止，避免误提交。
- 日志保存在 `%LOCALAPPDATA%\JD-SupplyChain\logs\rdc-pages-*.log`。

### 手工更新

交互式生成密文：

```powershell
cd C:\Users\yao.q.1\repos\jd-supplychain-public
.\scripts\build-rdc-inventory.ps1
```

使用已初始化的 DPAPI 密码检测、生成并发布：

```powershell
.\scripts\publish-rdc-inventory.ps1
```

仅在本地强制重建，不提交或推送：

```powershell
.\scripts\publish-rdc-inventory.ps1 -Force -NoPush
```

必须使用至少 12 位且不可猜测的密码。静态密文可被下载并离线尝试破解，因此密码强度是安全边界；不要把明文 Excel、密码或解密后的 JSON 提交到本仓库。

## ➕ 怎么新增页面

1. 写好 HTML（暗色统一风格），命名用**英文 slug**，如 `warehouse-cost-reduction.html`。
2. 放入 `pages/` 目录（除入口 `index.html` 外的所有页面都集中在这里）。
3. 在门户首页 `index.html` 的「📚 页面目录」加一张卡片。
4. **在本 README 的「🧭 网页导航」表格加一行**（保持这里与门户同步）。
5. 提交推送：
   ```powershell
   git add .
   git commit -m "docs: 新增 <页面名>"
   git push
   ```

## ⚙️ 部署说明

- GitHub Pages 源：分支 `main`，目录 `/(root)`。
- 每次 push 到 `main` 自动触发 `pages build and deployment` 构建（1–3 分钟）。
- 注意：**连续快速多次 push 会互相取消构建**——改完一批再一起 push，然后 `Ctrl+F5` 硬刷新查看。
