# 密码匣 Password Vault｜无需购买服务器的开源密码管理工具

密码匣让密码库留在自己手里：浏览器扩展可独立离线使用；需要跨设备同步时，在自己的 Windows（WSL）、macOS 或 Linux 设备上运行轻量服务。账号数据加密后存储，不依赖第三方在线密码网站。

Password Vault is a local-first, open-source password manager with a browser extension, encrypted backups, and optional self-hosted sync.

[![Latest release](https://img.shields.io/github/v/release/kangshifuSteven/password-vault?display_name=tag)](https://github.com/kangshifuSteven/password-vault/releases)
[![License](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](LICENSE)

## 为什么选择密码匣

- **装上扩展就能用。** 保存、搜索、生成和填充网站密码；登录、注册或改密后尝试自动更新记录。可从账号列表打开网站，并导入浏览器密码 CSV。
- **现有电脑就能存储和同步。** 可选的 Node.js 服务不需要 Docker 或数据库；扩展保存账号后自动同步加密保险库。服务离线时，常用电脑仍可使用本机保险库。
- **密码库可以带走。** 加密密码文件用于迁移；独立恢复备份和恢复私钥可在忘记主密码时重建保险库，备份由自己保管。
- **临时使用。** 从密码文件或自建同步服务取回账号，只读查看和填充；无需在临时浏览器建立长期保险库。

## 界面预览

| 桌面扩展 | 网页保险库 |
| :---: | :---: |
| <img src="docs/screenshots/extension-popup.png" alt="密码匣桌面扩展账号列表" height="300"> | <img src="docs/screenshots/web-vault.png" alt="密码匣网页保险库" height="300"> |

[查看手机账号页](docs/screenshots/mobile-vault.png) · [查看手机解锁页](docs/screenshots/mobile-login.png)

## 开始使用

从 [v0.1.0 发布页](https://github.com/kangshifuSteven/password-vault/releases/tag/v0.1.0) 下载对应文件；源码包和 SHA-256 校验文件也在该页面。

### 1. 安装桌面扩展

- **Chrome / Edge（Windows、macOS、Linux）：**下载 `password-vault-v0.1.0-chrome-edge.zip`，解压到固定目录。在 `chrome://extensions` 或 `edge://extensions` 开启开发者模式，选择“加载已解压的扩展”，指向包含 `manifest.json` 的目录。
- **Firefox 142+（桌面）：**下载 `password-vault-v0.1.0-firefox.zip` 并解压。在 `about:debugging#/runtime/this-firefox` 选择“临时载入附加组件”，选中 `manifest.json`。重启 Firefox 后需重新载入；目前没有长期安装的签名包。

打开扩展，设置至少 **12 位主密码**，建议使用更长且独一无二的密码短语。随后在“备份”页分别保存**加密恢复文件**与**恢复私钥**。首次使用会显示操作引导。

更新扩展时替换**原安装目录中的文件**，然后在扩展管理页点“重新加载”；不要加载第二份目录。卸载前先备份，浏览器可能同时删除本地保险库。

### 2. 启动自己的同步服务（可选）

只用扩展无需启动服务。需要同步时，在运行服务的设备上安装 [Node.js 22+](https://nodejs.org/en/download)：

- **Windows：**在管理员 PowerShell 执行 `wsl --install -d Ubuntu`，重启后进入 Ubuntu，并在 **Ubuntu 内**安装 Node.js 22+。已有 WSL 可跳过安装。
- **macOS：**直接在 Mac 上安装 Node.js 22+，打开“终端”；无需 WSL。
- **Linux：**安装 Node.js 22+，打开终端。

在 Ubuntu、macOS 或 Linux 终端执行以下命令。发布文件名中的 `server-wsl` 也适用于 macOS 和 Linux：

```sh
VERSION=0.1.0
mkdir -p "$HOME/password-vault"
curl -fL "https://github.com/kangshifuSteven/password-vault/releases/download/v${VERSION}/password-vault-v${VERSION}-server-wsl.tar.gz" -o "$HOME/password-vault-server.tar.gz"
tar -xzf "$HOME/password-vault-server.tar.gz" -C "$HOME/password-vault"
cd "$HOME/password-vault"
node server/server.mjs
```

服务运行时，同机打开 `http://127.0.0.1:39871/`。扩展解锁后默认自动连接本机服务；同一浏览器的本机网页可共享解锁状态。电脑关机或服务停止后无法远程同步，但扩展中的本地账号仍可使用。

**远程使用由用户自行部署。** 同一服务也可以运行在自己可访问、持续在线的设备上，通过 HTTPS 入口和设备令牌供其他设备连接；本项目目前不提供托管的远程服务。部署 HTTPS、重启和数据目录说明见 [服务端文档](server/README.md)。

### 3. 在其他设备使用

- **另一台自己的桌面电脑：**安装扩展，从同步服务加入现有保险库；没有服务时，用恢复备份和恢复私钥恢复。
- **临时电脑：**从扩展的“临时使用”入口选择密码文件或自建同步服务。已解锁的本机保险库可直接只读查看，返回时无需重输主密码。锁定或关闭浏览器会清除会话；下载的密码文件需自行删除。
- **手机、平板、macOS Safari：**打开同步服务的 HTTPS 网页，输入设备令牌和主密码，手动管理网站及 App 账号。同机 Safari 可打开本机地址。网页暂不支持其他网站或 App 的自动填充。

临时电脑不要保存恢复私钥。其他使用边界见 [安全说明](SECURITY.md)。

## 与常见工具相比

| 工具 | 密码匣适合的场景 |
| --- | --- |
| [Google 密码管理工具](https://support.google.com/chrome/answer/95606)等浏览器内置工具 | 想让主密码、恢复备份和可选同步服务独立于浏览器账号，并能把数据迁到自己的设备。 |
| [Bitwarden](https://bitwarden.com/help/self-host-bitwarden/)等云端或自托管服务 | 只需个人轻量使用，希望直接在已有电脑运行 Node.js 服务，不配置 Docker 或数据库。 |
| [KeePassXC](https://keepassxc.org/docs/KeePassXC_GettingStarted)等本地密码库 | 希望浏览器扩展自动同步密文，并通过自建网页在手机上手动管理账号。 |

目前手机浏览器和 App 不支持自动填充或自动记录；Safari 扩展、Passkey、TOTP 和泄露库查询尚未提供。网页端已在 Chromium、Firefox、WebKit 内核及 280-1200px 宽度下测试；macOS 同步服务通过 CI 检查，Mac 浏览器、夸克和鸿蒙设备尚未做实机验证。

## 文档与开发

[更新日志](CHANGELOG.md) · [安全说明](SECURITY.md) · [同步服务安装与 HTTPS](server/README.md) · [作者与发布来源](NOTICE.md) · [MPL-2.0 许可证](LICENSE)

使用 Node.js 22+ 运行检查：

```sh
node release-check.mjs
node tests/sync.test.mjs
node tests/firefox-compat.test.mjs
```

请勿提交真实保险库、恢复文件、访问令牌或浏览器导出的明文 CSV。第三方图标许可见 [LUCIDE-LICENSE](LUCIDE-LICENSE)。
