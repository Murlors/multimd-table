# multimd-table 协作规则

MultiMarkdown 表格的解析、规范写出和 Markdown 生态适配库。公开接口、使用方式及实现状态以 `README.md`、`docs/api.md` 为准。

## 实现与目录

- 核心语法和 writer 由 `crates/core/src/` 的同一 Rust 实现提供，JavaScript 经 WASM 调用；`src/core.ts`、`src/writer.ts` 是公开入口，不重新引入独立 TypeScript 解析器或 writer。
- `src/internal/` 管理 WASM 装载、私有传输和宿主模型；`src/remark.ts`、`src/marked.ts`、`src/markdown-it.ts` 只承担对应宿主的适配。
- API、源码范围和传输规则见 `docs/api.md`、`crates/core/README.md`；测试与性能口径见 `docs/baselines.md`，修改前按影响范围读取。

## 必须保留的契约

- 包为 ESM 多入口，公开调用在模块导入后保持同步；维护 `package.json` 的 exports、类型声明及独立消费者行为。
- 源范围和 scanner offset 按 UTF-16 code unit 计数，保留孤立代理项、大偏移和快照独立性，不用 UTF-8 字节偏移替代。
- 语法由核心拥有，单元格 Markdown 与外层容器语义由宿主拥有；保持各适配器的扩展、renderer 和选项行为，不在绑定层复制语法。
- Scanner 的原生状态须在成功、失败及嵌套异常路径中明确释放；最后一次读取快照后调用幂等 `dispose()`，不依赖垃圾回收作为正常生命周期。
- 保持合并单元格 origin 身份、分区边界与有效来源范围；writer 无法无损表示输入时显式失败，不静默截断或丢失内容。
- `test/fixtures/core-contracts.json` 是旧实现的冻结兼容合同，不用当前输出自动覆盖来消除失败；有意改变公开语义时先说明兼容影响，再审查对应合同变更。

## 开发与验证

- 使用 Vite+ 统一工具入口，Bun 管理依赖与执行专用脚本；核心开发需要 Rust 及 `wasm32-unknown-unknown` target。Cargo 保持 `--locked`，生成 WASM 由现有脚本管理。
- 常用入口：`vp install`；静态检查 `vp check`；测试 `vp test`；库打包 `vp pack`。完整验收 `vp run verify` 已包含独立消费者检查，也可单独运行 `vp run verify:package`。测试与打包自动准备 WASM；按变更风险选择所需检查。
- 跨语言完整模型验证使用 `vp run core:check`；依赖 Python/Go/原生编译环境，缺少环境时明确报告未覆盖。
- 性能使用 `vp run bench --out .performance/<新前缀>` 与 `vp run bench:compare`；对比相同机器、运行时和工作负载，区分公开调用总成本、分阶段诊断及冷启动，不沿用旧版本收益或回归数字作为当前结论。
- 生成的性能报告和向量放在已忽略的 `.performance/`，核心 Rust 编译产物放在 `crates/core/target/`；保持源码、测试、文档与生成产物的边界。

## 提交与发布

- 本仓库 commit message 使用英文 Conventional Commit；发布授权与应用仓库的提交规则分别判断。
- 包版本号、Git tag、本地构建、npm 发布和下游应用更新分别核验；开发实现变化不自动证明 npm 或 Noumi 已使用新版。
- 仅在用户明确要求时执行 commit、push 或发布。后续修改以当前源码与合同为起点，不恢复已淘汰实现作为长期双轨。
