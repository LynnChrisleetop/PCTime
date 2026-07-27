# PCTime

PCTime 是一款面向 Windows 的桌面使用时间统计工具。它会在本机记录当前活跃应用和窗口标题，并通过图表展示应用、窗口及自定义分类的使用时长。

## 功能

- 按今天、最近一周、本月、近一年、全部时间或指定日期查看统计
- 展示当前活跃应用、应用排行和窗口/页面排行
- 使用应用名称与窗口标题规则自动分类
- 自定义分类颜色和默认分类
- 将统计结果导出为 JSON 或 CSV
- 支持开机自启、启动后最小化以及系统托盘
- 支持通过 WebDAV 手动或定时同步数据

## 下载与使用

Windows 用户可以前往仓库的 [Releases](../../releases) 页面下载最新的 PCTime 压缩包。解压后运行 `PCTime.exe` 即可。

PCTime 会在本机 Electron 用户数据目录保存 `usage.json` 和 `config.json`。其中可能包含窗口标题、WebDAV 地址、账号和应用密码，请勿公开分享这些文件。

## 本地开发

环境要求：

- Windows 10/11
- Node.js 18 或更高版本
- npm

安装依赖并启动开发环境：

```bash
npm install
npm run dev
```

执行代码检查：

```bash
npm run lint
```

构建 Windows 版本：

```bash
npm run build
```

构建产物会生成在 `release/<version>/` 目录。

## 技术栈

- Electron
- React
- TypeScript
- Vite
- Chart.js
- active-win
- WebDAV

## 数据与隐私

- 使用统计默认仅保存在本机。
- 程序空闲超过 60 秒时暂停记录。
- 启用 WebDAV 后，统计与配置数据会同步到用户指定的服务器。
- WebDAV 密码保存在本机配置文件中，不会提交到本代码仓库。

## 项目结构

```text
electron/       Electron 主进程、预加载脚本及使用时间统计
src/            React 用户界面
public/         静态资源
release/        本地构建产物（不提交到 Git）
```
# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type aware lint rules:

- Configure the top-level `parserOptions` property like this:

```js
export default {
  // other rules...
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: ['./tsconfig.json', './tsconfig.node.json'],
    tsconfigRootDir: __dirname,
  },
}
```

- Replace `plugin:@typescript-eslint/recommended` to `plugin:@typescript-eslint/recommended-type-checked` or `plugin:@typescript-eslint/strict-type-checked`
- Optionally add `plugin:@typescript-eslint/stylistic-type-checked`
- Install [eslint-plugin-react](https://github.com/jsx-eslint/eslint-plugin-react) and add `plugin:react/recommended` & `plugin:react/jsx-runtime` to the `extends` list
