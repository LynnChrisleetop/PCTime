# PCTime Android 0.1.1

原生 Java Android 客户端，最低 Android 8.0（API 26），目标 Android 15（API 35）。名称与图标暂用 PCTime。无需 Android Studio。

## 安装与使用

1. 安装 `release/0.1.1/PCTime-Android-0.1.1-debug.apk`，这是使用本机构建密钥签名的调试包，用于个人试用，尚未发布到应用商店。
2. 在「使用记录权限」中跳转系统设置，为 PCTime 开启「使用情况访问权限」。返回后使用其他应用，再点击「刷新并同步」。
3. 无需登录即可查看默认的「本机离线记录」。账号和服务器表单默认收起，统一在线服务尚未部署。
   如已有自建服务，可展开「跨设备同步」中的「高级设置」，填写地址并登录与 Windows 相同的账号。手机访问电脑上的服务时应填写电脑局域网 IP，例如 `http://192.168.1.10:4318`；`127.0.0.1` 指向手机自身。
4. 在设备范围中切换全部设备、本机离线记录或具体手机/电脑。点击应用查看各设备贡献。微信、哔哩哔哩等应用由服务端的映射表统一归类。

全部设备使用时长直接累加，同时各用 10 分钟记为 20 分钟；日期按每台设备记录时的本地日期。系统事件里任一时刻最多计算一个前台应用，排除锁屏、灭屏、已知关机时段以及 PCTime 自身。分屏中的多个应用不会同时计时。Android 8 的事件信息少于新版系统，真实设备上的锁屏与厂商差异仍须实测。

周期任务每 15 分钟尝试采集和同步，可能受系统省电、强制停止和网络限制延后；返回应用或手动刷新会再次采集。系统只保留有限的原始事件，本应用最多尝试补采最近 7 天，已保存的日统计会一直保留。首次安装和长期未运行后的历史可能不完整。离线时会保留待同步记录，恢复网络后按日快照上传；重复上传不会累加两次。

上传内容是应用包名、应用名称、每天时长和设备名称/时区；没有窗口标题或屏幕内容。登录令牌经 Android Keystore 加密，密码不保存，应用备份关闭。退出账号停止上传，但继续保存本机统计。切换账号后，本机保存的历史会同步到新账号。公网仅接受 HTTPS，明文 HTTP 仅用于本机或私有局域网 IP，建议只在可信网络测试。应用没有内置云服务器，服务部署见仓库的跨设备使用说明。

## 在 Windows 构建

在仓库根目录运行 PowerShell。首次准备约需下载 500 MB，加上 Gradle/Maven 和 SDK 组件会占用更多磁盘空间。安装文件均放在仓库忽略的 `.artifacts/` 中，不修改系统 PATH。

先阅读 [Android SDK 许可条款](https://developer.android.com/studio/terms)。同意后运行：

```powershell
./android/setup.ps1 -AcceptAndroidSdkLicense
./android/test.ps1
./android/build.ps1
```

安装脚本固定并校验 Temurin JDK 17.0.20.1+1、Gradle 8.11.1、Android Command-line Tools 22.0 的下载散列，随后通过官方 SDK Manager 安装 platform 35、build-tools 35.0.0 与 platform-tools。构建使用 Android Gradle Plugin 8.9.1。不传许可接受参数时，安装脚本在下载前退出。若已有 JDK/SDK，可为 `build.ps1` 传 `-JavaHome`、`-AndroidHome`；Gradle 仍从上述本地目录读取。

构建脚本执行 `assembleDebug` 和 `lintDebug`，再用 `apksigner` 验证 APK 签名。成功后输出：

- `release/0.1.1/PCTime-Android-0.1.1-debug.apk`
- `.artifacts/android/PCTime-Android-debug.apk`
- Lint 报告：`android/app/build/reports/lint-results-debug.html`

纯 Java 测试验证跨午夜、锁屏、灭屏、快速切换、同包 Activity 切换、重复事件、断点接续、夏令时、时钟回拨和关机重启。编译与这些测试不能替代真机权限、后台任务和厂商省电策略的验证。真机测试应包含拒绝/撤销权限、离线后重连、切换账号、跨午夜、手机与 Windows 的同应用汇总。

调试密钥不适合公开发布。正式分发前需要配置自己保存的 release 签名密钥，并保留它用于后续升级；不要把密钥提交到仓库。
