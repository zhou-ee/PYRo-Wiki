# PYRo Wiki VS Code 插件安装教程

## 适用版本

本文适用于 PYRo Wiki VS Code 插件 `0.1.9`。

该版本包含：

- 多人实时 Markdown 协作；
- Yjs 增量同步；
- 断线重连和离线期间的会话内恢复；
- 在线成员显示；
- 远程光标和远程选区显示；
- Feishu 登录；
- PYRo Wiki Markdown 工作区功能。

> 每一位需要参与实时协作的用户，都需要在自己的 VS Code 中安装该插件。

## 一、获取安装包

请从管理员处获取以下 VSIX 安装包：

```text
pyro-wiki-vscode-extension-0.1.9.vsix
```

管理员当前生成的安装包位于：

```text
E:\Develop\a_PYRo\PYRo-Wiki\pyro-wiki-vscode-extension-0.1.9.vsix
```

安装包 SHA-256：

```text
6ea979c031278874b2ecb4b9209d9f77e531a68962d6d6790c49921d5f4c0040
```

如果通过网盘、即时通讯软件或其他方式传输安装包，可以使用 SHA-256 校验文件是否完整。

## 二、使用 VS Code 图形界面安装

1. 打开 VS Code。
2. 打开左侧的 **Extensions** / **扩展** 视图。
3. 点击右上角的 `...` 菜单。
4. 选择 **Install from VSIX...** / **从 VSIX 安装...**。
5. 选择管理员提供的 `pyro-wiki-vscode-extension-0.1.9.vsix`。
6. 等待安装完成。
7. 如果 VS Code 提示重新加载窗口，请点击 **Reload** / **重新加载**。

## 三、使用命令行安装

Windows PowerShell 示例：

```powershell
code --profile "PYRo-Wiki" --install-extension .\pyro-wiki-vscode-extension-0.1.9.vsix --force
```

如果 VSIX 不在当前目录，请使用完整路径，例如：

```powershell
code --profile "PYRo-Wiki" --install-extension "C:\Users\你的用户名\Downloads\pyro-wiki-vscode-extension-0.1.9.vsix" --force
```

如果系统提示找不到 `code` 命令，请直接使用 VS Code 图形界面的 **Install from VSIX...** 方式安装。

## 四、登录和初始化

安装完成后：

1. 使用 `PYRo-Wiki` Profile 打开 VS Code。
2. 打开 PYRo Wiki 工作区目录。
3. 打开一个 Wiki Markdown 文件。
4. 在命令面板中执行：

   ```text
   PYRo Wiki: Sign in with Feishu
   ```

5. 按浏览器页面提示完成 Feishu 登录。
6. 返回 VS Code，确认左侧出现 **PYRo Wiki** 活动栏。

生产协作服务地址为：

```text
https://pyro-wiki-api.luckyy.ccwu.cc
```

通常不需要手动填写该地址；插件会使用默认生产配置。

## 五、初始化 Wiki 工作区

如果是在一台新电脑或一个空文件夹中开始使用 PYRo Wiki，需要先初始化工作区：

1. 在 VS Code 中打开一个空文件夹。
2. 打开命令面板。
3. 执行：

   ```text
   PYRo Wiki: Initialize Wiki Workspace
   ```

4. 按提示选择初始化方式。
5. 等待插件通过 PYRo Worker 拉取共享 Wiki 的标准内容。
6. 初始化完成后，重新打开或刷新需要编辑的 Markdown 文件。

该命令通过生产 Worker 获取共享 Wiki 快照，不会让插件直接 clone 或 pull GitHub 仓库。

如果当前文件夹已经包含 Wiki 内容，插件会在写入文件前提供类似以下选择：

- `Pull and replace`：使用共享 Wiki 内容替换当前工作区内容；
- `Pull missing only`：只补充当前工作区缺少的文件。

请在确认文件内容和覆盖范围后再选择。初始化或拉取过程中不要直接关闭 VS Code。

如果拉取完成后需要生成或运行 VitePress，而工作区或父级 `node_modules` 中找不到可用的 VitePress，插件可能会询问是否执行 `Run npm install`。只有在确认网络和依赖来源可信时再执行安装。
## 六、开始多人实时协作

每位用户完成安装和登录后：

1. 打开同一个 PYRo Wiki 工作区。
2. 打开同一个 Markdown 文件。
3. 开始编辑文件。
4. 插件会在本地编辑发生时自动加入对应的协作房间。
5. 左侧 **PYRo Wiki → Collaboration** 视图中可以查看：
   - 当前协作状态；
   - 在线成员；
   - 成员正在编辑的文档；
   - 最近协作事件。

当其他用户编辑同一文件时：

- 远程文本会实时出现；
- 远程用户的选区会显示为颜色背景；
- 远程光标会显示用户名称和对应颜色；
- 当前用户自己的光标不会以远程光标形式重复显示。

## 七、断线和离线编辑

如果网络暂时断开：

- 本地仍然可以继续编辑 Markdown；
- 插件会显示 reconnecting 状态；
- 插件会按照指数退避自动重连；
- 网络恢复后会使用 Yjs 增量状态合并本地和远程修改。

本版本的离线恢复范围是当前 VS Code 扩展会话。如果完全退出 VS Code 后再重新打开，未完成同步的会话内编辑不保证恢复。

## 八、退出协作

协作房间会在当前文档连续 5 分钟没有编辑后自动退出。关闭文档、切换到其他文档或退出 VS Code，也会清理当前客户端的协作连接和远程光标显示。

如果插件版本中显示 **PYRo Wiki: Leave Collaboration** 命令，也可以手动执行该命令退出当前协作房间；退出后不会继续自动重连当前房间。

## 九、常见问题

### 1. 左侧没有 PYRo Wiki 图标

确认：

- VSIX 已成功安装；
- VS Code 窗口已经重新加载；
- 当前使用的是 `PYRo-Wiki` Profile；
- 扩展列表中能看到 `PYRo Wiki`。

### 2. 提示需要 Feishu 登录

在命令面板执行：

```text
PYRo Wiki: Sign in with Feishu
```

完成浏览器登录后返回 VS Code。

### 3. 看不到其他成员

确认：

- 双方安装的是 `0.1.9` 或兼容版本；
- 双方登录的是允许访问 PYRo Wiki 的账号；
- 双方打开的是同一个工作区；
- 双方打开的是同一个相对文档路径；
- 左侧 Collaboration 视图没有显示错误。

### 4. 远程文本可以同步，但看不到远程光标

远程光标和选区需要双方使用包含 awareness 功能的 `0.1.9` 插件。旧版本客户端可能只能进行基础文本协作，不能完整显示远程光标和选区。

### 5. 如何升级插件

获取新的 `.vsix` 后，重复安装步骤即可。命令行可以使用：

```powershell
code --profile "PYRo-Wiki" --install-extension .\新的插件文件.vsix --force
```

安装后重新加载 VS Code。

## 十、给管理员的分发建议

建议管理员通过以下方式之一分发 VSIX：

- 团队文件共享目录；
- 受控网盘；
- 团队内部即时通讯文件传输；
- 内部软件发布系统。

不要把 Feishu Token、刷新 Token、Worker Secret 或其他敏感信息放入 VSIX 或教程中。用户只需要安装 VSIX，并通过插件打开 Feishu 登录流程即可。