# iHub Clipboard History

`ihub-plugin-clipboard` 是一个独立的 TypeScript/Vite 官方插件。它提供可筛选、固定、复制、删除的**用户主动收集**文本集合，界面使用 iHub 的深石墨与青绿色调。

## 隐私与能力边界

- 只有点击“收集当前内容”时才会调用 `clipboard.readText`；不会后台轮询、监听或收集剪贴板。
- 只处理纯文本：不会读取图片、文件、HTML 或富文本附件。
- 已收集条目保存在 iHub 的插件范围本机设置中，最多 36 条、每条最多 1,500 个字符；不上传网络。
- 写回系统剪贴板只会在用户点击“复制”时调用 `clipboard.writeText`。
- 唯一请求的敏感权限是 `clipboard.read` 与 `clipboard.write`；不请求文件系统、原生二进制、通知、shell 或网络权限。

## 当前宿主集成

iHub 当前公开的前端 bridge 支持 `clipboard.readText` / `clipboard.writeText`，但尚未提供 `clipboard.history.*` 方法。因此本插件是“主动收集的本机文本集合”，不会读取内置工具的全局、后台采集剪贴板历史，也不会假装具备这项能力。

当宿主未来提供经用户同意的、受限的 `clipboard.history.list` / `copy` / `pin` API 时，可在不增加后台监控的前提下，把它接到同一界面。

## 开发与构建

```powershell
pnpm --dir plugins/official/ihub-plugin-clipboard run check
pnpm --dir plugins/official/ihub-plugin-clipboard run build
pnpm --dir plugins/official/ihub-plugin-clipboard run dev
```

`dist/` 是 Git 导入时由 iHub 加载的前端产物；iHub 不会在导入、安装或启动时执行 npm/pnpm 脚本。项目将轻量的 iHub frontend bridge 客户端随源码提供，不依赖根仓库的 SDK 包；单独克隆后即可安装依赖、检查并构建。

浏览器预览使用内存设置和标准浏览器 Clipboard API。若浏览器拒绝读取权限，插件会明确报错并保持本地界面可用；桌面端由 iHub bridge 完成受清单限制的读写调用。
