# hermes-trajectory

[English](README.md) | 中文

一个只读的 Hermes Desktop 插件，把一次对话显示成按时间排列的账本：用户消息、助手回复和工具调用。

## 显示内容

- **历史记录** —— 来自 `session.history` 的用户与助手文本，包括其中记录的工具调用。
- **实时细节** —— 插件运行期间，`tool.start` / `tool.complete` 提供工具参数、结果文本和耗时。
- **如实标注缺失** —— Hermes 的展示历史里，历史工具行没有结果和耗时。插件会明确说明，而不是显示空内容或编造输出。

## 数据与隐私

| 来源 | 用途 |
|---|---|
| `session.history` | 消息和历史工具调用的元数据 |
| `tool.start` / `tool.complete` | 实时工具参数、结果、耗时 |
| `message.start` / `message.complete` | 轮次活动状态与历史刷新触发 |

插件**不会**写文件、发起网络请求、读取数据库或保存凭据。条目只保存在内存中，每场会话最多保留最近 100 条。

## 已知限制

- 历史工具输出无法由本插件恢复。只有插件运行期间观察到的调用才带结果。
- 当网关在 `tool.complete` 中报告 `is_error: true` 时，实时工具会标记为 **failed**。仅仅是看起来像报错的文本不会被判定为失败。历史工具行通常没有结果或失败标记，因此无法标记失败。
- 工具结果在内存中最多保留 2,000 个字符，插件重载后会丢失。
- 插件只在内容进入 `session.history` 后显示；它不会把空的 `message.start` 载荷当作你的提问。
- 不支持跨设备同步，也不支持完整的持久化事件回放。

## 测试

插件没有构建步骤。测试用 Node VM 和伪造的 Hermes SDK 加载 `plugin.js`：

```sh
node test/plugin.test.cjs
```

## 安装（本地，目录发布前）

把 `plugin.js` 复制到：

```
<HERMES_HOME>/desktop-plugins/hermes-trajectory/plugin.js
```

目录名必须与插件 id 一致。然后在 **Capabilities → Plugins** 中启用 **Trajectory**。没有构建步骤。

## 许可证

MIT。见 [LICENSE](LICENSE)。
