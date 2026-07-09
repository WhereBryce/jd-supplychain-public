# jd-supplychain-public

JD 供应链团队知识库的**对外发布站**（GitHub Pages 托管）。所有网页在此维护，通过下面的门户统一导航。

🌐 **发布站根地址**：<https://wherebryce.github.io/jd-supplychain-public/>

## 🧭 网页导航

| 页面 | 类型 | 说明 | 链接 |
|---|---|---|---|
| 门户首页 | 导航 | 所有页面的总入口（页面目录） | <https://wherebryce.github.io/jd-supplychain-public/> |
| 团队知识库使用指南 | 指南 | 怎么往 Inbox 贡献材料、云⇄本地运转方式、AI 协作触发词（含二维码） | <https://wherebryce.github.io/jd-supplychain-public/guide.html> |
| 仓配费节降通用框架 | 洞察·仓配成本 | 仓配费 = 非异常+异常，按 费项→方式→抓手 三层拆解的跨品类节降骨架（含流程图） | <https://wherebryce.github.io/jd-supplychain-public/insights/warehouse-cost-reduction.html> |

## 📁 目录结构

```text
jd-supplychain-public/          # Pages 从 /(root) 发布
  index.html                    # 门户首页（页面目录·唯一总入口）
  guide.html                    # 团队知识库使用指南
  insights/                     # 洞察 / 方法论类页面
    warehouse-cost-reduction.html
  reports/                      # (预留) 报告类页面
  assets/                       # (预留) 共用 css/js/图片
  .nojekyll                     # 关闭 Jekyll 处理
  README.md
```

## ➕ 怎么新增页面

1. 写好 HTML（暗色统一风格），命名用**英文 slug**，如 `warehouse-cost-reduction.html`。
2. 按类型放目录：指南类放根目录、洞察类放 `insights/`、报告类放 `reports/`。
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
