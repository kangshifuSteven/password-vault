# 同步服务

同步服务保存加密保险库及历史版本，并提供网页端。需要 Node.js 22+；无需 Docker 或数据库。

## 在 WSL/Linux 启动

将项目目录放在 WSL/Linux 可持久保存的位置，然后运行：

```sh
node server/server.mjs
```

首次启动会在 `~/.local/share/password-vault/access-token` 生成管理员令牌，在同目录保存当前账号文件 `vault.json` 和历史文件 `vault-revision-*.json`；设备授权另存于 `devices.json`。这些文件中的账号数据均已加密。请保护整个目录并额外备份它。可用 `PASSWORD_VAULT_DATA_DIR`、`PASSWORD_VAULT_PORT` 改路径和端口。服务默认只监听 `127.0.0.1:39871`，不会对局域网开放。

Ubuntu 已启用 systemd 时，也可以安装仓库提供的用户服务：

```sh
install -D -m 0644 server/server.mjs ~/.local/lib/password-vault/server.mjs
install -D -m 0644 crypto.js ~/.local/lib/password-vault/crypto.js
install -D -m 0644 sync.js ~/.local/lib/password-vault/sync.js
install -D -m 0644 i18n.js ~/.local/lib/password-vault/i18n.js
install -D -m 0644 web/index.html ~/.local/lib/password-vault/web/index.html
install -D -m 0644 web/app.js ~/.local/lib/password-vault/web/app.js
install -D -m 0644 web/style.css ~/.local/lib/password-vault/web/style.css
install -D -m 0644 server/password-vault.service ~/.config/systemd/user/password-vault.service
systemctl --user daemon-reload
systemctl --user enable --now password-vault.service
sudo loginctl enable-linger "$USER"
systemctl --user status password-vault.service
```

服务随 Ubuntu 的用户 systemd 启动；更新程序后执行 `systemctl --user daemon-reload` 和 `systemctl --user restart password-vault.service`。上述安装命令不会改动原令牌和保险库。不要把令牌贴进公开仓库或截图。

Windows 重启后，手动打开 Ubuntu 终端即可启动已启用的服务。运行 `systemctl --user status password-vault.service` 检查状态；需要重启时运行 `systemctl --user restart password-vault.service`。保持 Ubuntu 终端打开，否则 WSL 实例可能停止。

需要 Windows 登录自启时，可在“任务计划程序”新建任务：触发器选“用户登录时”；操作选“启动程序”，程序填 `C:\Windows\System32\wsl.exe`，参数填 `-d Ubuntu --exec sleep infinity`；在“设置”中取消“如果任务运行超过 3 天则停止”。已启用的 systemd 用户服务会随 Ubuntu 启动。删除该任务即可取消自启。安装过程不会自动创建这个任务。

## 在 macOS 启动

Mac 上安装 Node.js 22 或更新版本，从 [Releases](https://github.com/kangshifuSteven/password-vault/releases) 下载文件名以 `server-wsl.tar.gz` 结尾的服务端包。它是跨平台 Node.js 程序，Mac 无需安装 WSL。将包解压到固定目录，在该目录打开终端运行：

```sh
node server/server.mjs
```

保持终端和 Mac 运行。数据默认保存在 `~/.local/share/password-vault/`；同机 Chrome/Edge 扩展解锁后会自动连接 `http://127.0.0.1:39871`。Safari 可打开该地址手动管理，但目前没有 Safari 扩展或网页自动填充。让手机或其他电脑访问时，仍须自己配置 HTTPS 入口；Mac 休眠或关机时远程同步不可用。

本机扩展解锁后会自动连接 `http://127.0.0.1:39871`，不必手填地址或令牌。本机网页版会检测当前浏览器扩展是否已连接并解锁：已连接时直接打开同一会话，锁定和过期也会同步；未连接时才需要输入主密码，提交时自动完成本机配对。若连接失败，先在 Windows 访问 `http://127.0.0.1:39871/v1/vault`；正常会返回 401。不要为了连通把服务端绑定到 `0.0.0.0`。

其他设备需要自己的 HTTPS 入口。服务可以运行在现有电脑、长期在线的 Mac/Linux 设备，或用户自行准备的远程主机；当前项目不提供托管服务器。代理只指向 `127.0.0.1:39871`，**不能代理配对端口 39872**。在服务网页登录后，打开“设备”，为远程设备生成专用令牌；在远程设备填写 HTTPS 地址和该令牌。令牌只显示一次，可以随时从“设备”页撤销。不要把裸 HTTP 端口暴露到局域网或公网。

## 浏览器页面

在运行服务的电脑打开 `http://127.0.0.1:39871/`，输入主密码即可解锁。其他设备通过自己的 HTTPS 地址访问，并填写各自的设备令牌。页面支持搜索、添加、编辑、删除、生成和复制密码，以及下载当前加密密码文件。网页只在当前标签页内保留令牌、主密码派生的密钥和解密内容；15 分钟无操作或页面离开时锁定。下载的文件仍需**原主密码**，不能替代扩展导出的独立恢复备份。

若扩展里已有账号：可直接在扩展“同步”页连接本机服务。两边都有账号时，输入服务端主密码，预览后合并；此浏览器之后使用服务端主密码。也可在扩展“备份”页点“导出密码文件”，再在本页面点“导入密码文件”，选择密码匣导出的加密 JSON 并输入主密码；浏览器导出的明文 CSV 不适用于这里。服务端已有账号时，会先列出新增和更新数量，再选择合并或覆盖；覆盖前会再次确认，旧数据保留在历史版本。

网页“历史”页可查看和下载旧版本。同一主密码下的版本可以确认后恢复，恢复会生成一个新版本；其他设备需重新加入。用过不同主密码的旧版本仍可下载，但必须用对应的旧主密码通过导入流程处理。网页“设备”页可更换管理员令牌；本机扩展下次同步会自动重新配对，远程设备应使用各自的专用令牌。扩展保存账号后会自动上传；如果另一台设备已经产生新版本，客户端先合并互不冲突的修改，同一账号同时修改时才要求选择，避免离线设备互相覆盖。

手机浏览器（包括夸克、UC 和鸿蒙浏览器）使用代理提供的 HTTPS 地址打开页面。登录网站或 App 后回到页面点“添加账号”：网站记录填写域名，App 记录选择“App”并填写 App 名称。保存后会写入同一份加密保险库，其他设备解锁后自动取回。手机浏览器不能安装本项目的桌面扩展，网页也不能读取其他 App 的登录内容；首次记录需要手动确认。

页面可以在具备安全上下文和 Web Crypto 的现代浏览器中管理账号，但不能自动填充其他网站或应用。移动设备上的系统级自动填充还需要对应平台的原生扩展或应用。临时设备可能记录输入和剪贴板，请只在可信设备上打开。

网页端代码由同步服务提供。部署和更新时使用可信来源，并保护服务文件；使用边界见 [安全说明](../SECURITY.md)。

## 恢复与维护

服务器目录中的 `vault.json` 是当前加密账号文件，`vault-revision-*.json` 是更新前的历史版本。扩展会拒绝服务器版本回退或保险库盐值改变；恢复后需在其他设备重新加入。管理员令牌泄露时，在网页“设备”页更换；设备令牌泄露时撤销对应设备。令牌不能代替主密码，也不能单凭令牌解密账号。

定期从扩展导出加密恢复文件，并把恢复私钥单独保存在安全位置。服务器快照无法解决忘记主密码、误删整库或密钥不可用。扩展的“临时使用”可从加密密码文件，或用户自行部署的 HTTPS 服务读取账号；远程方式需要设备令牌，但不会把令牌或保险库写入扩展的持久存储。关闭浏览器会清除临时会话；下载到磁盘的密码文件不会自动删除。

若用恢复文件设置了新主密码，扩展会断开原同步连接。确认恢复内容和本机、服务器备份后，可在同步页明确选择用当前本机库重建服务器副本。旧服务器数据仍留在历史版本中；其他设备不能继续用旧密钥同步，需先处理各自未上传的更改，再重新加入。
