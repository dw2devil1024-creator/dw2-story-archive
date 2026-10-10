# DW2 · Preset Console（预设控制台）

这是专为 **TauriTavern / TT** 准备的独立第三方扩展试验版，参考小冰块悬浮预设控制器的使用体验，但并非小冰块代码的复制品。它与 **DW2 · Story Archive（书架）** 相互独立。

## 当前功能

- 手机和桌面均可使用的可拖动悬浮入口；保存位置
- 自动读取**当前 Chat Completion 预设的真实条目**
- 条目开关：调用 PromptManager 的当前角色顺序和保存接口，不改写条目内容
- 星标常用：根据名称与同名条目出现序号保存，便于重新导入预设后尝试重新匹配
- 织界身份双选：优先识别「织界｜世界演绎者」与「墨团子 · 原创小说家」，只让两条**身份核心**互斥；「墨团子｜小说叙事增强」是独立叠加项，绝不因切换身份被关闭
- 分组面板：从当前预设内的 baiBaiToolkit 分组元数据动态读取 31 个分组及对应关系，支持展开／收起；没有相应数据时退回全部条目
- 变量初始化保护：匹配「变量初始化｜别动」分组及 Agent System Prompt 等条目，只显示锁定状态，不允许从插件内误关
- 正则页：读取/切换 TT 的全局、角色、预设正则，走 TT 原生存储接口和聊天刷新协调器
- 搜索与状态同步

## 注意事项

**这是开发候选版，尚未经过实际 TT iPhone／安卓测试。请先备份 TT 设置和预设。**

- 预设面板只有在 PromptManager 已加载且对应 Chat Completion 预设处于当前上下文时才显示条目。
- 织界 v6.58 的标准身份条目会以**明确名称**识别；如果用户改名或版本结构不同，可以手动绑定身份条目，未绑定且找不到时不会擅自切换。
- 自定义分组数据只有在 TT 正确保存／导入 baiBaiToolkit 分组信息的情况下才可供面板读取。其缺失不妨碍普通列表开关。
- **分享给已安装同版本织界的小伙伴时，一般只需提供本扩展安装链接**。插件不包含预设正文；旧版本不具备的新条目不会由插件补齐。
- 正则单条开启并不等于允许整个角色/预设来源执行。未授权的来源会显示提示，控制台不会自动授权。
- 收藏映射依赖名称和重复序号；重命名、重复条目改序后，应检查收藏和模式绑定。
- 插件**不导入、删除、修改预设条目的文本**，也不重写原正则查找式与替换内容。
- TT 的实际 UI 和同步表现仍需多端验证；本版暂不作为正式稳定版本发布。

## 目录说明与安装

此目录目前位于 **Story Archive 仓库的独立开发分支**中：

    projects/dw2-preset-console/
      manifest.json
      index.js
      style.css
      README.md

**不要把当前书架仓库地址直接作为这个控制台的安装地址。** TT 扩展安装器从仓库根目录读取 manifest.json，而该仓库根目录仍然属于 Story Archive。

想像小冰块一样通过 GitHub 一键安装，需要先**新建独立的 GitHub 仓库**（例如 dw2-preset-console），再将本目录的文件放到该新仓库**根目录**。然后在 TT 扩展管理中输入新仓库的 URL 安装。

不需要修改 Story Archive 主程序，也不建议把本目录的 manifest.json 覆盖书架的 manifest.json。

## 结构与接口

- src/scripts/openai.js: promptManager
- src/scripts/PromptManager.js: getPromptOrderForCharacter, getPromptOrderEntry, saveServiceSettings
- src/scripts/extensions/regex/engine.js: getScriptsByType, saveScriptsByType
- src/scripts/tauri/perf/regex-refresh-coordinator.js: requestFlush

本仓库测试分支上的项目源代码使用相对 import 路径，面向 TT 的 third-party extensions 标准放置目录。

## 分享与版本适配

这个扩展不替代预设。小伙伴已导入相同版本《织界》时，无需再次导入预设，安装扩展即可读取她自己当前预设与状态；她的私有开关调整保留在自己的 TT 中。插件的收藏、悬浮位置与个别身份绑定配置存储于她设备本地，不会同步到其他人设备。

**正式分享前**要检查：当前版本的动态分组读取与 TT 实际设置对象的一致性，以及预设重新导入后分组元数据是否随导入保留。

## 待实机测试

- iOS TestFlight 的触摸拖动／点击是否稳定
- 多主题 CSS 抢权与弹窗层级
- 导入不同预设后的同步，以及同名条目
- 正则来源授权状态与开关、旧消息展示刷新
- 角色与预设切换后的状态是否一致

项目版本：0.1.0（开发候选）
