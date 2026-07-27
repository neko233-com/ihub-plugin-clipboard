# iHub Clipboard History

`ihub-plugin-clipboard` 是一个独立的 TypeScript/Vite 官方插件。它提供可筛选、固定、复制、删除的**用户主动收集**文本集合，界面使用 iHub 的深石墨与青绿色调。

## 隐私与能力边界

- 只有点击“收集当前内容”时才会调用 `clipboard.readText`；不会后台轮询、监听或收集剪贴板。
- 只处理纯文本：不会读取图片、文件、HTML 或富文本附件。
- 已收集条目保存在 iHub 的插件范围本机设置中，最多 36 条、每条最多 1,500 个字符；不上传网络。
- 写回系统剪贴板只会在用户点击“复制”时调用 `clipboard.writeText`。
- 唯一请求的敏感权限是 `clipboard.read`、`clipboard.write` 与 `clipboard.history`；不请求文件系统、原生二进制、通知、shell 或网络权限。

## iHub 内置历史（只读快照）

`clipboard.history` 是独立于 `clipboard.read` 的明确清单权限；本插件的完整剪贴板权限是：

```json
{ "clipboard": { "read": true, "write": true, "history": true } }
```

用户点击“加载 iHub 历史”后，插件才调用 `clipboard.history.snapshot()`。宿主最多返回 36 条**已经在 iHub 内置工具中启用的**纯文本历史记录；调用不会启用历史记录、轮询/读取系统剪贴板，或将记录保存到插件设置、搜索索引或网络。

这个区域只读：没有 iHub 全局历史的删除、固定或清空入口。每条记录仅可由用户主动点击“复制”写回系统剪贴板；这不会修改该历史条目的固定/删除状态。

## 开发与构建

```powershell
pnpm --dir plugins/official/ihub-plugin-clipboard run check
pnpm --dir plugins/official/ihub-plugin-clipboard run build
pnpm --dir plugins/official/ihub-plugin-clipboard run dev
```

`dist/` 是 Git 导入时由 iHub 加载的前端产物；iHub 不会在导入、安装或启动时执行 npm/pnpm 脚本。项目将轻量的 iHub frontend bridge 客户端随源码提供，不依赖根仓库的 SDK 包；单独克隆后即可安装依赖、检查并构建。

浏览器预览使用内存设置和标准浏览器 Clipboard API。若浏览器拒绝读取权限，插件会明确报错并保持本地界面可用；桌面端由 iHub bridge 完成受清单限制的读写调用。
