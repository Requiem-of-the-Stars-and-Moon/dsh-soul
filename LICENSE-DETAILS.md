# 许可证说明

## 项目许可证

dsh-soul 项目主体采用 [MIT License](LICENSE)。在遵守许可证条件的前提下，你可以：

- 使用本项目；
- 复制和分发本项目；
- 修改本项目；
- 将修改后的版本用于个人、商业或其他用途；
- 将本项目或其修改版本与其他软件组合发布。

再发布本项目或其重要部分时，需要保留原版权声明和 MIT 许可证文本。软件按“现状”提供，作者不对特定用途、稳定性或适用性作保证，也不承担因使用软件产生的责任。

## 第三方代码

本项目包含以下 vendored 第三方代码：

- `lib/vendor/schemastery.cjs`：基于 `@deepseek-ai/schemastery` 3.18.4，MIT License，Copyright (c) 2021-present Shigma。
- `lib/vendor/cosmokit.js`：基于 `@deepseek-ai/cosmokit`，MIT License，Copyright (c) 2021-present Shigma。

这些代码仍受其原许可证约束。修改或再发布包含这些文件的版本时，也必须保留其版权声明和许可证文本。完整许可文本见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## DSH 与其他组件

dsh-soul 是面向 DSH 的独立插件。DSH、Node.js 以及用户安装的其他组件不属于本项目的授权范围，分别受其各自的许可证和使用条款约束。

## 内容与运行数据

本项目不包含用户的聊天记录、人格数据或记忆数据库。运行时产生的数据归使用者管理，不会因为本项目采用 MIT License 而自动向项目作者授予访问权限。
