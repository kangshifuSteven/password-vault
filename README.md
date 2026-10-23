# 密码匣

独立于浏览器账号的开源密码管理工具。账号由主密码加密，数据保存在你的浏览器或自托管服务中。

[![Latest release](https://img.shields.io/github/v/release/kangshifuSteven/password-vault?display_name=tag)](https://github.com/kangshifuSteven/password-vault/releases)
[![License](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](LICENSE)

当前版本：**0.1.0**

## 功能

- 为网站和 App 保存独立账号，搜索、编辑、复制和生成密码。
- Chrome、Edge 桌面扩展支持匹配填充，并尝试记录登录、注册和改密结果。
- 导入浏览器 CSV；导出加密密码文件，以及公钥加密的独立恢复备份。
- 可选 WSL/Linux 自托管同步；网页端适合手机浏览器、平板和其他设备。
- 本机优先，服务器只保存加密保险库；多设备修改自动合并，冲突时由用户选择。

## 预览

![桌面扩展](docs/screenshots/extension-popup.png)
![网页保险库](docs/screenshots/web-vault.png)
![手机解锁](docs/screenshots/mobile-login.png)
![手机网页](docs/screenshots/mobile-vault.png)

## 下载

从 [Releases](https://github.com/kangshifuSteven/password-vault/releases) 选择对应版本：

| 文件 | 用途 |
| --- | --- |
| `password-vault-vX.Y.Z-chrome-edge.zip` | Chrome / Edge 开发者模式加载 |
| `password-vault-vX.Y.Z-firefox.zip` | Firefox 临时加载或签名安装 |
| `password-vault-vX.Y.Z-server-wsl.tar.gz` | WSL / Linux 自托管服务 |
| `password-vault-vX.Y.Z-source.zip` | 完整源码 |
| `password-vault-vX.Y.Z-checksums.txt` | SHA-256 校验 |

手机浏览器、平板和鸿蒙浏览器使用服务端 HTTPS 页面，不安装桌面扩展。

## 快速开始

1. 下载 `chrome-edge.zip`，解压到固定目录。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开启“开发者模式”，选择“加载已解压的扩展”。
3. 创建至少 16 位主密码，并在“备份”页分别保存恢复私钥和加密恢复文件。

首次打开会显示操作引导。升级时使用同一扩展目录点击“重新加载”，不要移除原扩展或拖入另一份目录。

## 自托管服务

在 WSL 或 Linux 中按 [服务端说明](server/README.md) 启动服务。扩展解锁后会自动连接本机服务；在同一浏览器打开服务端页面时会共享解锁状态。远程设备使用 HTTPS 地址和设备令牌加入。

## 支持范围

| 平台 | 方式 |
| --- | --- |
| Chrome / Edge（Windows、macOS、Linux） | 安装扩展，支持网页填充和自动保存尝试 |
| Firefox 桌面版 | 临时加载扩展；长期安装需要签名 |
| 手机浏览器、平板、鸿蒙浏览器 | 打开服务端 HTTPS 页面，手动查看、添加和复制 |
| 手机 App | 在网页保险库保存为 App 账号，使用时复制 |

手机端目前不读取系统密码，也不提供系统级自动填充；Safari 扩展、Passkey、TOTP 和泄露库查询暂未提供。
网页端已在 Chromium、Firefox、WebKit 内核和 280-1200px 宽度下测试；macOS、鸿蒙设备尚未做实机验证。

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
