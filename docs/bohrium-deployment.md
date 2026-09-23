# 玻尔开发机部署记录

检查时间：2026-09-23。目标为本机 SSH 别名 `myself`，代码目录 `/personal/PCTime`，分支 `codex/cross-device-screen-time`。

## 已准备好的内容

- Ubuntu 22.04 / x86_64 容器开发机，已安装校验过官方 SHA-256 的 Node.js 24.21.0，运行后端不需要安装 npm 依赖。
- 服务以独立的 `pctime` 系统账号运行，由单独的 Supervisor 管理，异常退出后会自动重启；管理接口仅为 root 可访问的本地 Unix socket。
- 当前仅监听 `127.0.0.1:4318`，`/healthz` 检查通过。尚未开放公网接口，也未把开发机地址预设进客户端。
- `/personal` 是 NFS 网络盘。代码保存在 `/personal/PCTime`，活动数据库放在容器本地磁盘 `/var/lib/pctime/pctime.sqlite`，备份保存在 `/personal/PCTime-service/backups`，日志保存在 `/personal/PCTime-service/logs`。
- 每分钟尝试通过 SQLite 备份 API 生成一致性快照：先在本地完成、检查完整性，再复制到网络盘并原子发布，保留最近 60 份。不会直接复制正在写入的 WAL 数据库文件。
- 本地数据库不存在时，从最新快照恢复；已有数据库不覆盖。数据库损坏、最新快照损坏或存在孤立 WAL 时停止启动，等待人工处理，避免悄悄清空或回退账号数据。
- 已在容器 `/etc/supervisord.conf` 追加下一次启动时的引导入口，原配置保存在 `/personal/PCTime-service/platform-supervisord.before-pctime.conf`。没有重载或重启平台 SSH 服务。

## 已验证与尚未验证

18 项服务端测试已在该 Linux 开发机通过，使用临时数据库。5 项备份/恢复测试分别在 Windows 和该开发机通过，涵盖已提交 WAL、恢复、已有数据库保护、损坏快照、孤立 WAL 及保留策略。实际服务启动、健康检查、服务进程重启以及持续生成备份均已验证。

尚未重启整台开发机，不能宣称平台开机自启已实际验证；也未修改玻尔的自动关机设置。临时 SSH 端口转发验证被执行环境的自动审批拦截，未提供具体原因，因此客户端通过转发访问这一项未验证。当前没有注册真实账号或上传用户屏幕时间数据。

## 日常检查

连接 `myself` 后执行：

```sh
supervisorctl -c /personal/PCTime-service/supervisord.conf status
curl --noproxy '*' http://127.0.0.1:4318/healthz
cat /var/lib/pctime/backup-status.json
```

`backup-status.json` 记录最近一次成功备份的时间，应检查时间是否仍在更新；旧的 `ok: true` 不代表当前备份仍然正常。

仅重启本应用的 API 服务：

```sh
supervisorctl -c /personal/PCTime-service/supervisord.conf restart pctime
```

如果容器重建导致系统盘、系统账号或 Node.js 安装丢失，保留 `/personal` 后重新执行以下命令。引导脚本会从保留的官方归档恢复 Node.js 并重建账号；数据库会从最近快照恢复。命令前台运行，管理员可结合平台启动入口使用：

```sh
bash /personal/PCTime/server/ops/bohrium-start.sh
```

如平台的启动配置也被重置，再执行：

```sh
python3 /personal/PCTime/server/ops/bohrium-register-boot.py
```

这些脚本针对本次 `/personal/PCTime` 实例，不能原样拿去启动第二个共享同一备份目录的开发机。备份含账号和统计数据，目录权限已限制，不要公开分享。全新恢复可能丢失最后一次成功备份之后的数据，通常约一分钟，备份失败或延迟时会更久；这不是零数据丢失的生产存储方案。

## 下一步：上线“登录即同步”

1. 确定固定的 HTTPS 子域名及路由方式。玻尔文档说明开发机可通过指定端口提供公网服务，但当前尚未测试该实例的公网端口可达性。平台提供的 SSH 域名不等于已经提供适合 App 使用的 HTTPS 接口。
2. 按实际入口选择 HTTPS 反向代理或受管理的隧道，API 继续监听本机地址。证书必须能被 Windows / Android 正常信任。
3. 在玻尔控制台确认自动关机、长期运行费用及磁盘生命周期；为了验证开机恢复，需要安排一次允许中断的整机重启。
4. 长期对外服务建议使用不会随容器重建丢失的本地块存储，或迁移到独立的持久化数据库，并建立保留更久的备份。现有网络盘快照方案用于开发和个人试用。
5. 用手机流量和电脑分别验证注册、登录、同步和断网恢复，之后再预设服务地址并重新打包两个客户端。

参考：[玻尔节点限制](https://bohrium-doc.dp.tech/docs/faq/Machine/)、[SQLite WAL 与网络文件系统](https://www.sqlite.org/wal.html)。
