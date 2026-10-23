# 密码匣 Password Vault｜无需购买服务器的开源密码管理工具

不想把所有密码留在某个浏览器账号里，又不想为了自托管购买云服务器？密码匣是一款本机优先的开源密码管理工具：装上浏览器扩展就能离线使用；需要同步时，让现有 Windows 电脑的 WSL、Mac 或 Linux 设备保存加密保险库。**无需购买服务器、注册第三方密码服务，也无需 Docker 或数据库。**若要从外网随时取回账号，可以把同一服务部署到自己可访问的设备，并配置 HTTPS。

Password Vault is an open-source, local-first password manager with a browser extension, encrypted backups, and optional self-hosted sync on WSL, macOS, or Linux.

[![Latest release](https://img.shields.io/github/v/release/kangshifuSteven/password-vault?display_name=tag)](https://github.com/kangshifuSteven/password-vault/releases)
[![License](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](LICENSE)

当前版本：**0.1.0**

## 密码匣能帮你省掉什么

- **省掉一台付费服务器。**已有电脑安装 Node.js 即可运行轻量同步端；扩展自动上传加密后的保险库。电脑关机时远程同步暂停，本机扩展仍可离线使用。
- **省掉对在线密码网站的依赖。**桌面以插件填充和管理密码，不开服务端也能使用；主密码和独立恢复备份由自己保管。
- **省掉迁移时从零开始。**可导入浏览器密码 CSV，换电脑或浏览器时用加密恢复文件与恢复私钥找回数据。卸载扩展前必须先保存这两份备份，卸载可能删除本地保险库。
- **临时电脑也能查用账号。**切换“临时使用”，从加密密码文件或自己的 HTTPS 服务读取账号；只查看和填充，锁定后不在该浏览器保留保险库。
- **从账号直达网站。**在密码匣找到网站账号后点“打开网站”，跳转到对应站点，再使用匹配填充。

## 与常见密码管理方式相比

| 常见方案 | 它擅长什么 | 密码匣多解决的一步 |
| --- | --- | --- |
| [Google 密码管理工具](https://support.google.com/chrome/answer/95606)等浏览器内置工具 | 不用另装扩展，也支持导出密码 | 独立主密码和加密恢复备份；可把密文同步到自己的电脑，迁移不依赖原浏览器的同步账号。 |
| [Bitwarden](https://bitwarden.com/help/self-host-bitwarden/)等云端或自托管服务 | 功能丰富，也提供自托管方案 | 个人用户直接在现有电脑上启动 Node.js 服务，无需 Docker、数据库或购买服务器；断线后扩展仍能用本机保险库。 |
| [KeePassXC](https://keepassxc.org/docs/KeePassXC_GettingStarted)等本地密码库 | 离线数据库和浏览器集成 | 内置轻量服务端，扩展保存后自动同步密文；手机用网页手动管理，无需另配数据库文件同步。 |

## 目前能做什么

- 为网站和 App 保存独立账号，搜索、编辑、复制和生成密码。
- 从网站账号直接打开对应网站；临时模式可在其他电脑上只读查看和填充。
- Chrome、Edge 桌面扩展支持匹配填充，并尝试记录登录、注册和改密结果。
- 导入浏览器 CSV；导出加密密码文件，以及公钥加密的独立恢复备份。
- 可选 WSL/macOS/Linux 自托管同步；网页端适合手机浏览器、平板和其他设备。当前默认连接本机服务；同一服务也能由用户自行部署到可远程访问的设备，并配置 HTTPS。本项目目前不提供托管的远程服务。
- 本机优先，服务器只保存加密保险库；多设备修改自动合并，冲突时由用户选择。

## 预览

![桌面扩展](docs/screenshots/extension-popup.png)
![网页保险库](docs/screenshots/web-vault.png)
![手机解锁](docs/screenshots/mobile-login.png)
![手机网页](docs/screenshots/mobile-vault.png)

## 安装与启动

从 [Releases](https://github.com/kangshifuSteven/password-vault/releases/tag/v0.1.0) 下载 `0.1.0`：

| 文件 | 用途 |
| --- | --- |
| `password-vault-v0.1.0-chrome-edge.zip` | Windows、macOS、Linux 的 Chrome / Edge 扩展 |
| `password-vault-v0.1.0-firefox.zip` | 桌面 Firefox 扩展，当前需临时加载 |
| `password-vault-v0.1.0-server-wsl.tar.gz` | WSL、macOS、Linux 通用的 Node.js 服务端 |
| `password-vault-v0.1.0-source.zip` | 完整源码 |
| `password-vault-v0.1.0-checksums.txt` | 下载文件的 SHA-256 校验值 |

### Windows、macOS、Linux：桌面扩展

1. 使用 Chrome 或 Edge 时，解压 `chrome-edge.zip` 到固定目录。打开 `chrome://extensions` 或 `edge://extensions`，开启“开发者模式”，选择“加载已解压的扩展”，选中包含 `manifest.json` 的目录。Mac 不需要 WSL 就能用扩展。
2. 使用 Firefox 142+ 桌面版时，解压 `firefox.zip`，打开 `about:debugging#/runtime/this-firefox`，点“临时载入附加组件”，选择 `manifest.json`。**Firefox 重启后需要重新载入**；当前没有可长期安装的签名包。
3. 首次打开扩展，创建至少 12 位主密码，建议使用更长、独一无二的密码短语；在“备份”页分别保存加密恢复文件和恢复私钥。

首次打开会显示操作引导。更新扩展时替换**原目录中的文件**，再在扩展管理页点“重新加载”；不要移除原扩展或加载第二份目录。卸载前先备份，否则浏览器可能一并删除本地保险库。

### Windows、macOS、Linux：启动自己的同步服务（可选）

只用扩展无需启动服务端。需要备份和跨设备同步时，先按自己的系统安装 [Node.js 22 或更新版本](https://nodejs.org/en/download)：

| 系统 | 准备方式 |
| --- | --- |
| Windows | 在管理员 PowerShell 运行 `wsl --install -d Ubuntu`（已安装可跳过），按提示重启后打开 Ubuntu；**在 Ubuntu 内**安装 Node.js 22+。参见 [WSL 安装说明](https://learn.microsoft.com/windows/wsl/install)。 |
| macOS | 在 Mac 上安装 Node.js 22+，打开“终端”；不需要 WSL。 |
| Linux | 在 Linux 上安装 Node.js 22+，打开终端。 |

在 Ubuntu、macOS 或 Linux 的终端运行以下命令。服务端包虽然名为 `server-wsl`，也适用于 Mac 和 Linux：

```sh
VERSION=0.1.0
mkdir -p "$HOME/password-vault"
curl -fL "https://github.com/kangshifuSteven/password-vault/releases/download/v${VERSION}/password-vault-v${VERSION}-server-wsl.tar.gz" -o "$HOME/password-vault-server.tar.gz"
tar -xzf "$HOME/password-vault-server.tar.gz" -C "$HOME/password-vault"
cd "$HOME/password-vault"
node server/server.mjs
```

保持终端和电脑运行。在同一电脑打开 `http://127.0.0.1:39871/`；扩展解锁后会自动连接本机服务，网页端在同一浏览器共享解锁状态。需要异地使用时，可把同一服务放在自己持续在线的设备上，通过 HTTPS 访问并使用设备令牌；本项目目前没有可直接登录的公共远程服务。详细设置、重启和 HTTPS 访问见 [服务端说明](server/README.md)。

### 临时电脑：只读取回账号

在扩展解锁页切换到“临时使用”，选择其中一种来源：

1. **密码文件：**在常用电脑的“备份”页先点“导出密码文件”，把加密 JSON 带到临时电脑，输入原主密码。不要在临时电脑使用恢复私钥。
2. **自建服务器：**你的服务已通过 HTTPS 对外可用时，输入 HTTPS 地址、该设备的令牌和原主密码，直接读取服务器上的加密保险库，无需先下载文件。令牌可在服务网页的“设备”页创建。

临时模式只供查看、复制、打开网站和匹配填充；不能添加、修改或同步账号。5 分钟无操作会锁定。离开前主动锁定、关闭浏览器，并删除临时电脑上的下载文件。临时设备若装有窃密软件，仍可能记录输入或复制的密码。

### 手机、平板和 Safari

手机浏览器（包括夸克）、iPad、鸿蒙浏览器和 Mac Safari 使用服务端网页，**无需安装桌面扩展**。在服务端电脑的“设备”页创建设备令牌；为服务端配置 HTTPS 入口后，在其他设备打开该 HTTPS 地址，输入设备令牌和主密码。网站及 App 账号可手动添加、查看和复制；当前不支持这些浏览器及手机 App 的自动填充或自动记录。Mac Safari 在同一电脑可直接打开上述本机地址。

网页端已在 Chromium、Firefox、WebKit 内核和 280-1200px 宽度下测试；macOS 服务端通过 CI 启动及同步测试，Mac 浏览器和鸿蒙设备尚未做实机验证。Safari 扩展、Passkey、TOTP 和泄露库查询暂未提供。

## 文档

- [更新日志](CHANGELOG.md)
- [安全说明](SECURITY.md)
- [服务端安装与 HTTPS](server/README.md)
- [MPL-2.0 许可证](LICENSE)
- [作者与发布来源](NOTICE.md)

## 开发

需要 Node.js 22 或更新版本：

```sh
node release-check.mjs
node tests/sync.test.mjs
node tests/firefox-compat.test.mjs
```

请勿提交真实保险库、恢复文件、访问令牌或浏览器导出的明文 CSV。

## 许可证

项目采用 [MPL-2.0](LICENSE)。第三方图标许可见 [LUCIDE-LICENSE](LUCIDE-LICENSE)。
